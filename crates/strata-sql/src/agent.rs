use sqlparser::{
    ast::Statement,
    dialect::{MsSqlDialect, OracleDialect, PostgreSqlDialect},
    parser::Parser,
};

use crate::{
    Dialect, StmtClass, classify,
    lexer::{Kind, lex},
    split, utf16_to_byte,
};

pub fn strict_statement(text: &str, dialect: Dialect) -> Result<(&str, StmtClass), &'static str> {
    if text.len() > 128_000 {
        return Err("SQL exceeds the agent statement limit");
    }
    let spans = split(text, dialect, false);
    let [span] = spans.as_slice() else {
        return Err("Exactly one statement is required");
    };
    if span.repeat != 1 {
        return Err("Repeated batches are not available through MCP");
    }
    let range = utf16_to_byte(text, span.start)
        .zip(utf16_to_byte(text, span.end))
        .ok_or("Cannot read the SQL statement")?;
    let sql = &text[range.0..range.1];
    let nodes = parse(sql, dialect).ok_or("The SQL could not be classified confidently")?;
    if nodes.len() != 1 {
        return Err("Exactly one statement is required");
    }
    Ok((sql, classify(sql, dialect)))
}

pub fn agent_dml(sql: &str, dialect: Dialect) -> bool {
    matches!(
        parse(sql, dialect).as_deref(),
        Some([Statement::Insert(_)
            | Statement::Update(_)
            | Statement::Delete(_)
            | Statement::Merge(_)])
    )
}

pub fn sql_server_dml_without_output(sql: &str) -> bool {
    agent_dml(sql, Dialect::SqlServer)
        && !lex(sql, Dialect::SqlServer)
            .iter()
            .any(|token| token.kind == Kind::Word && token.text(sql).eq_ignore_ascii_case("OUTPUT"))
}

pub fn agent_read_allowed(sql: &str, dialect: Dialect) -> bool {
    let tokens: Vec<_> = lex(sql, dialect)
        .into_iter()
        .filter(|token| !matches!(token.kind, Kind::Space | Kind::Comment))
        .collect();
    for (index, pair) in tokens.windows(2).enumerate() {
        let [name, next] = pair else { continue };
        if next.text(sql) != "(" || !matches!(name.kind, Kind::Word | Kind::Quoted) {
            continue;
        }
        let value = name.text(sql).to_ascii_uppercase();
        if index >= 2 && tokens[index - 1].text(sql) == "." {
            let namespace = tokens[index - 2].text(sql).trim_matches(['"', '[', ']']);
            let builtin = match dialect {
                Dialect::Postgres => namespace.eq_ignore_ascii_case("pg_catalog"),
                Dialect::SqlServer | Dialect::Oracle => namespace.eq_ignore_ascii_case("sys"),
            };
            if !builtin || index >= 3 && tokens[index - 3].text(sql) == "." {
                return false;
            }
        }
        // Restrict routines to SQL operations with read semantics. This also protects
        // Oracle calls from functions that start an autonomous transaction.
        if !matches!(
            value.as_str(),
            "COUNT"
                | "SUM"
                | "AVG"
                | "MIN"
                | "MAX"
                | "COALESCE"
                | "NULLIF"
                | "CAST"
                | "TRY_CAST"
                | "CONVERT"
                | "TRY_CONVERT"
                | "LOWER"
                | "UPPER"
                | "TRIM"
                | "LTRIM"
                | "RTRIM"
                | "SUBSTRING"
                | "SUBSTR"
                | "LENGTH"
                | "LEN"
                | "ABS"
                | "ROUND"
                | "FLOOR"
                | "CEIL"
                | "CEILING"
                | "MOD"
                | "ROW_NUMBER"
                | "RANK"
                | "DENSE_RANK"
                | "LEAD"
                | "LAG"
                | "DATE_TRUNC"
                | "EXTRACT"
                | "TO_CHAR"
                | "TO_DATE"
                | "TO_NUMBER"
                | "CONCAT"
                | "OVER"
                | "IN"
                | "EXISTS"
                | "AS"
                | "FROM"
                | "VALUES"
                | "WHERE"
                | "AND"
                | "OR"
                | "NOT"
                | "ON"
                | "SELECT"
                | "TOP"
                | "FILTER"
                | "DISTINCT"
                | "INTO"
                | "WHEN"
                | "THEN"
                | "ELSE"
        ) {
            return false;
        }
    }
    true
}

pub fn audit_sql(sql: &str, dialect: Dialect) -> String {
    let mut output = String::new();
    for token in lex(sql, dialect) {
        let raw = token.text(sql);
        match token.kind {
            Kind::Comment => output.push(' '),
            Kind::Quoted
                if !(raw.starts_with('"')
                    || dialect == Dialect::SqlServer && raw.starts_with('[')) =>
            {
                output.push_str("'[redacted]'")
            }
            Kind::Unterminated => output.push_str("[redacted]"),
            _ => output.push_str(raw),
        }
    }
    output
}

pub(crate) fn parse(sql: &str, dialect: Dialect) -> Option<Vec<Statement>> {
    let dialect: &dyn sqlparser::dialect::Dialect = match dialect {
        Dialect::Postgres => &PostgreSqlDialect {},
        Dialect::SqlServer => &MsSqlDialect {},
        Dialect::Oracle => &OracleDialect {},
    };
    Parser::new(dialect)
        .with_recursion_limit(64)
        .try_with_sql(sql)
        .and_then(|mut parser| parser.parse_statements())
        .ok()
}
