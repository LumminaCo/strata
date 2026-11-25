package main

import (
	"encoding/json"
	"testing"
	"time"
)

func TestHandshakeAndErrorFrames(t *testing.T) {
	b := bridge{connections: make(map[uint64]*connection)}
	reply := b.handle(request{ID: 42, Method: "hello", Params: json.RawMessage(`{}`)})
	if reply.ID != 42 || reply.Error != nil || reply.Result.(map[string]int)["version"] != version {
		t.Fatalf("invalid handshake: %+v", reply)
	}
	reply = b.handle(request{ID: 43, Method: "fetch", Params: json.RawMessage(`{"conn_id":1}`)})
	if reply.ID != 43 || reply.Error == nil || reply.Error.Code != "connect" {
		t.Fatalf("invalid missing-session error: %+v", reply)
	}
	b.connections[7] = &connection{}
	for _, bad := range []string{"", "   ", `bad"name`, "bad\x00name"} {
		payload, _ := json.Marshal(map[string]any{"conn_id": 7, "schema": bad})
		reply = b.handle(request{ID: 44, Method: "set_schema", Params: payload})
		if reply.Error == nil || reply.Error.Code != "config" {
			t.Fatalf("expected config error for schema %q: %+v", bad, reply)
		}
	}
}

func TestWireValuesPreservePrecisionAndOffset(t *testing.T) {
	const number = "1234567890123456789012345678.1234567890"
	if value := wireValue(number, "NUMBER"); value != number {
		t.Fatalf("changed decimal: %v", value)
	}
	date := time.Date(2026, 1, 20, 10, 30, 0, 0, time.FixedZone("fixture", -18000))
	if value := wireValue(date, "TIMESTAMP WITH TIME ZONE"); value != "2026-01-20 10:30:00-05:00" {
		t.Fatalf("changed timestamp: %v", value)
	}
	if value := wireValue([]byte{0, 255}, "RAW"); value != "0x00ff" {
		t.Fatalf("changed binary: %v", value)
	}
}

func TestNormalizeBindsConvertsWholeNumbersToInt64(t *testing.T) {
	normalized := normalizeBinds([]any{"SFBZ0800", float64(101), float64(0), float64(3.5), nil})
	if normalized[0] != "SFBZ0800" {
		t.Fatalf("unexpected string bind: %#v", normalized[0])
	}
	if value, ok := normalized[1].(int64); !ok || value != 101 {
		t.Fatalf("expected int64(101), got %#v (%T)", normalized[1], normalized[1])
	}
	if value, ok := normalized[2].(int64); !ok || value != 0 {
		t.Fatalf("expected int64(0), got %#v (%T)", normalized[2], normalized[2])
	}
	if value, ok := normalized[3].(float64); !ok || value != 3.5 {
		t.Fatalf("expected float64(3.5), got %#v (%T)", normalized[3], normalized[3])
	}
	if normalized[4] != nil {
		t.Fatalf("expected nil bind, got %#v", normalized[4])
	}
}
