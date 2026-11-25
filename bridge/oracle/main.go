// Command oracle-bridge serves versioned JSON frames over standard input and output.
package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sijms/go-ora/v2"
)

const version = 1
const maxCellBytes = 16 << 20

type request struct {
	ID     uint64          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (f failure) Error() string { return f.Message }

type response struct {
	ID     uint64   `json:"id"`
	Result any      `json:"result,omitempty"`
	Error  *failure `json:"error,omitempty"`
}

type params struct {
	Connection  uint64 `json:"conn_id"`
	Query       uint64 `json:"query_id"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Service     string `json:"service"`
	User        string `json:"user"`
	Password    string `json:"password"`
	SID         string `json:"sid"`
	Descriptor  string `json:"descriptor"`
	Role        string `json:"role"`
	TLS         string `json:"tls"`
	Wallet      string `json:"wallet"`
	SQL         string `json:"sql"`
	Bind        []any  `json:"bind"`
	ReturnsRows bool   `json:"returns_rows"`
	Count       int    `json:"n"`
	Timeout     uint32 `json:"timeout_ms"`
	Enabled     bool   `json:"enabled"`
	Schema      string `json:"schema"`
}

type bridge struct {
	mu          sync.RWMutex
	connections map[uint64]*connection
	next        atomic.Uint64
}

type socketDialer struct {
	mu     sync.Mutex
	socket net.Conn
}

func (d *socketDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	socket, err := (&net.Dialer{}).DialContext(ctx, network, address)
	if err == nil {
		d.mu.Lock()
		d.socket = socket
		d.mu.Unlock()
	}
	return socket, err
}

func (d *socketDialer) current() net.Conn {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.socket
}

type connection struct {
	mu               sync.Mutex
	cancelMu         sync.Mutex
	cancel           context.CancelFunc
	db               *sql.DB
	conn             *sql.Conn
	tx               *sql.Tx
	rows             *sql.Rows
	columns          []column
	query            uint64
	output           bool
	readOnly         bool
	schema           string
	closed           bool
	socket           *socketDialer
	reset            atomic.Bool
	queryContext     context.Context
	implicitReadOnly *sql.Tx
}

type column struct {
	Name string `json:"name"`
	Type string `json:"db_type"`
}

type executeResult struct {
	Query    uint64   `json:"query_id"`
	Columns  []column `json:"columns,omitempty"`
	Affected *int64   `json:"affected,omitempty"`
	Messages []string `json:"messages,omitempty"`
}

type page struct {
	Rows      [][]any `json:"rows"`
	Exhausted bool    `json:"exhausted"`
}

func main() {
	serve(os.Stdin, os.Stdout)
}

func serve(input io.Reader, output io.Writer) {
	server := bridge{connections: make(map[uint64]*connection)}
	encoder := json.NewEncoder(output)
	var send sync.Mutex
	scan := bufio.NewScanner(input)
	scan.Buffer(make([]byte, 64<<10), 16<<20)
	for scan.Scan() {
		var frame request
		if err := json.Unmarshal(scan.Bytes(), &frame); err != nil || frame.ID == 0 {
			continue
		}
		go func() {
			reply := server.handle(frame)
			send.Lock()
			defer send.Unlock()
			_ = encoder.Encode(reply)
		}()
	}
}

func (s *bridge) handle(frame request) response {
	var args params
	if err := json.Unmarshal(frame.Params, &args); err != nil {
		return response{ID: frame.ID, Error: &failure{Code: "protocol", Message: "Invalid Oracle bridge arguments"}}
	}
	result, err := s.call(frame.Method, args)
	if err != nil {
		info := safeError(err)
		return response{ID: frame.ID, Error: &info}
	}
	return response{ID: frame.ID, Result: result}
}

func (s *bridge) call(method string, p params) (any, error) {
	switch method {
	case "hello":
		return map[string]int{"version": version}, nil
	case "connect":
		c, err := connect(p)
		if err != nil {
			return nil, err
		}
		id := s.next.Add(1)
		s.mu.Lock()
		s.connections[id] = c
		s.mu.Unlock()
		return map[string]uint64{"conn_id": id}, nil
	}
	s.mu.RLock()
	c := s.connections[p.Connection]
	s.mu.RUnlock()
	if c == nil {
		return nil, failure{Code: "connect", Message: "Oracle session has closed"}
	}
	if method == "cancel" {
		c.interrupt()
		return true, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, failure{Code: "connect", Message: "Oracle session has closed"}
	}
	if method != "close" && c.reset.Swap(false) {
		c.closeQuery()
		c.tx = nil
		_ = c.conn.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		conn, err := c.db.Conn(ctx)
		cancel()
		if err != nil {
			c.reset.Store(true)
			return nil, failure{Code: "connect", Message: "Could not reopen the Oracle session"}
		}
		c.conn = conn
		if c.schema != "" {
			_, _ = c.conn.ExecContext(context.Background(), fmt.Sprintf(`ALTER SESSION SET CURRENT_SCHEMA = "%s"`, c.schema))
		}
		if c.output {
			_, _ = c.conn.ExecContext(context.Background(), "BEGIN DBMS_OUTPUT.ENABLE(NULL); END;")
		}
	}
	switch method {
	case "close":
		c.closed = true
		c.closeQuery()
		if c.tx != nil {
			_ = c.tx.Rollback()
		}
		_ = c.conn.Close()
		_ = c.db.Close()
		s.mu.Lock()
		delete(s.connections, p.Connection)
		s.mu.Unlock()
		return true, nil
	case "execute":
		return c.execute(p)
	case "fetch":
		return c.fetch(p)
	case "close_query":
		if c.query == p.Query {
			c.closeQuery()
		}
		return true, nil
	case "begin":
		c.closeQuery()
		if c.tx != nil {
			return nil, failure{Code: "config", Message: "An Oracle transaction is already active"}
		}
		tx, err := c.conn.BeginTx(context.Background(), nil)
		if err != nil {
			return nil, err
		}
		if c.readOnly {
			if _, err := tx.ExecContext(context.Background(), "SET TRANSACTION READ ONLY"); err != nil {
				_ = tx.Rollback()
				return nil, err
			}
		}
		c.tx = tx
		return true, nil
	case "commit", "rollback":
		c.closeQuery()
		if c.tx == nil {
			return true, nil
		}
		tx := c.tx
		c.tx = nil
		if method == "commit" {
			return true, tx.Commit()
		}
		return true, tx.Rollback()
	case "set_read_only":
		c.readOnly = p.Enabled
		return true, nil
	case "ping":
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return true, c.conn.PingContext(ctx)
	case "dbms_output":
		c.closeQuery()
		call := "BEGIN DBMS_OUTPUT.DISABLE; END;"
		if p.Enabled {
			call = "BEGIN DBMS_OUTPUT.ENABLE(NULL); END;"
		}
		_, err := c.exec(context.Background(), call)
		if err == nil {
			c.output = p.Enabled
		}
		return true, err
	case "set_schema":
		c.closeQuery()
		schema := strings.TrimSpace(p.Schema)
		if schema == "" || strings.ContainsAny(schema, "\"\x00") {
			return nil, failure{Code: "config", Message: "Invalid Oracle schema name"}
		}
		_, err := c.exec(context.Background(), fmt.Sprintf(`ALTER SESSION SET CURRENT_SCHEMA = "%s"`, schema))
		if err == nil {
			c.schema = schema
		}
		return true, err
	default:
		return nil, failure{Code: "protocol", Message: "Unknown Oracle bridge method"}
	}
}

func connect(p params) (*connection, error) {
	options := map[string]string{"PREFETCH_ROWS": "128"}
	if p.SID != "" {
		options["SID"] = p.SID
	}
	if p.Role != "" {
		options["DBA PRIVILEGE"] = p.Role
	}
	if p.TLS != "disable" && p.TLS != "prefer" {
		options["SSL"] = "enable"
		options["SSL VERIFY"] = "true"
	}
	if p.Wallet != "" {
		options["WALLET"] = p.Wallet
	}
	var address string
	if p.Descriptor != "" {
		address = go_ora.BuildJDBC(p.User, p.Password, p.Descriptor, options)
	} else {
		address = go_ora.BuildUrl(p.Host, p.Port, p.Service, p.User, p.Password, options)
	}
	dialer := &socketDialer{}
	connector := go_ora.NewConnector(address).(*go_ora.OracleConnector)
	connector.Dialer(dialer)
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		info := safeError(err)
		if info.Code == "ORA-01017" {
			return nil, failure{Code: "auth", Message: "Authentication failed"}
		}
		return nil, failure{Code: "connect", Message: "Could not connect to Oracle"}
	}
	return &connection{db: db, conn: conn, socket: dialer}, nil
}

func (c *connection) exec(ctx context.Context, query string, bind ...any) (sql.Result, error) {
	if c.tx != nil {
		return c.tx.ExecContext(ctx, query, bind...)
	}
	return c.conn.ExecContext(ctx, query, bind...)
}

func (c *connection) interrupt() {
	c.cancelMu.Lock()
	defer c.cancelMu.Unlock()
	if c.cancel != nil {
		c.cancel()
	}
}

func (c *connection) monitor(ctx context.Context) func() {
	done := make(chan struct{})
	socket := c.socket.current()
	go func() {
		select {
		case <-done:
			return
		case <-ctx.Done():
		}
		timer := time.NewTimer(350 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
			if socket != nil {
				c.reset.Store(true)
				_ = socket.Close()
			}
		}
	}()
	return func() { close(done) }
}

func (c *connection) closeQuery() {
	if c.rows != nil {
		_ = c.rows.Close()
		c.rows = nil
	}
	if c.implicitReadOnly != nil {
		_ = c.implicitReadOnly.Rollback()
		c.implicitReadOnly = nil
	}
	c.cancelMu.Lock()
	defer c.cancelMu.Unlock()
	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}
}

func (c *connection) execute(p params) (executeResult, error) {
	c.closeQuery()
	bind := normalizeBinds(p.Bind)
	var ctx context.Context
	var cancel context.CancelFunc
	if p.Timeout > 0 {
		ctx, cancel = context.WithTimeout(context.Background(), time.Duration(p.Timeout)*time.Millisecond)
	} else {
		ctx, cancel = context.WithCancel(context.Background())
	}
	c.cancelMu.Lock()
	c.cancel = cancel
	c.cancelMu.Unlock()
	c.queryContext = ctx
	finish := c.monitor(ctx)
	defer finish()
	if !p.ReturnsRows {
		defer c.closeQuery()
		result, err := c.exec(ctx, p.SQL, bind...)
		if err != nil {
			if ctx.Err() != nil {
				return executeResult{}, ctx.Err()
			}
			return executeResult{}, err
		}
		affected, _ := result.RowsAffected()
		return executeResult{Affected: &affected, Messages: c.readOutput(ctx)}, nil
	}
	var rows *sql.Rows
	var err error
	if c.tx != nil {
		rows, err = c.tx.QueryContext(ctx, p.SQL, bind...)
	} else if c.readOnly {
		c.implicitReadOnly, err = c.conn.BeginTx(context.Background(), nil)
		if err == nil {
			_, err = c.implicitReadOnly.ExecContext(ctx, "SET TRANSACTION READ ONLY")
		}
		if err == nil {
			rows, err = c.implicitReadOnly.QueryContext(ctx, p.SQL, bind...)
		}
	} else {
		rows, err = c.conn.QueryContext(ctx, p.SQL, bind...)
	}
	if err != nil {
		interrupted := ctx.Err()
		c.closeQuery()
		if interrupted != nil {
			return executeResult{}, interrupted
		}
		return executeResult{}, err
	}
	c.rows = rows
	types, err := rows.ColumnTypes()
	if err != nil {
		c.closeQuery()
		return executeResult{}, err
	}
	c.columns = make([]column, len(types))
	for i, typ := range types {
		c.columns[i] = column{Name: typ.Name(), Type: typ.DatabaseTypeName()}
	}
	c.query++
	return executeResult{Query: c.query, Columns: c.columns}, nil
}

func (c *connection) fetch(p params) (page, error) {
	if c.rows == nil || c.query != p.Query {
		return page{}, failure{Code: "protocol", Message: "The Oracle cursor is closed"}
	}
	ctx := c.queryContext
	finish := c.monitor(ctx)
	defer finish()
	count := min(1000, max(p.Count, 1))
	size := 0
	result := page{Rows: make([][]any, 0, count)}
	for range count {
		if !c.rows.Next() {
			err := c.rows.Err()
			if ctx.Err() != nil {
				err = ctx.Err()
			}
			c.closeQuery()
			result.Exhausted = true
			return result, err
		}
		values := make([]any, len(c.columns))
		dest := make([]any, len(values))
		for i := range dest {
			dest[i] = &values[i]
		}
		if err := c.rows.Scan(dest...); err != nil {
			c.closeQuery()
			return page{}, err
		}
		for i, value := range values {
			values[i] = wireValue(value, c.columns[i].Type)
			if text, ok := values[i].(string); ok {
				size += len(text)
			}
		}
		result.Rows = append(result.Rows, values)
		if size >= 4<<20 {
			break
		}
	}
	return result, nil
}

func (c *connection) readOutput(ctx context.Context) []string {
	var lines []string
	if !c.output {
		return lines
	}
	for range 1000 {
		var line string
		var status int64
		_, err := c.exec(ctx, "BEGIN DBMS_OUTPUT.GET_LINE(:1, :2); END;",
			go_ora.Out{Dest: &line, Size: 32767}, sql.Out{Dest: &status})
		if err != nil || status != 0 {
			break
		}
		lines = append(lines, line)
	}
	return lines
}

func normalizeBinds(values []any) []any {
	if len(values) == 0 {
		return values
	}
	out := make([]any, len(values))
	for i, value := range values {
		if number, ok := value.(float64); ok && math.Trunc(number) == number && number >= -(1<<53) && number <= (1<<53) {
			out[i] = int64(number)
			continue
		}
		out[i] = value
	}
	return out
}

func wireValue(value any, dbType string) any {
	switch value := value.(type) {
	case []byte:
		if len(value) > maxCellBytes {
			return fmt.Sprintf("[Value: %d bytes]", len(value))
		}
		return "0x" + hex.EncodeToString(value)
	case time.Time:
		layout := "2006-01-02 15:04:05.999999999"
		if strings.Contains(dbType, "TZ") || strings.Contains(dbType, "TIME ZONE") {
			layout += "-07:00"
		}
		return value.Format(layout)
	case string:
		if len(value) > maxCellBytes {
			return fmt.Sprintf("[Value: %d bytes]", len(value))
		}
		return value
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return fmt.Sprint(value)
		}
		return value
	case nil, int64, bool:
		return value
	default:
		return fmt.Sprint(value)
	}
}

func safeError(err error) failure {
	var info failure
	if errors.As(err, &info) {
		return info
	}
	if errors.Is(err, context.Canceled) {
		return failure{Code: "cancelled", Message: "The Oracle query was cancelled"}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return failure{Code: "timeout", Message: "The Oracle operation timed out"}
	}
	message := err.Error()
	if strings.HasPrefix(message, "ORA-") && len(message) >= 9 {
		code := message[:9]
		if code == "ORA-01013" {
			return failure{Code: "cancelled", Message: "The Oracle query was cancelled"}
		}
		return failure{Code: code, Message: strings.TrimPrefix(message, code+": ")}
	}
	return failure{Code: "bridge", Message: "The Oracle driver did not complete the operation"}
}
