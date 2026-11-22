//! SQL tokenization, statement selection, and conservative classification.

mod lexer;

use lexer::{Kind, lex};
use sqlparser::{
    ast::Statement,
    dialect::{MsSqlDialect, OracleDialect, PostgreSqlDialect},
    parser::Parser,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Dialect {
    Postgres,
    SqlServer,
    Oracle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StmtClass {
    Read,
    Write,
    Ddl,
    TxControl,
    Session,
    Procedural,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Span {
    pub start: u32,
    pub end: u32,
    pub kind_hint: StmtClass,
    pub repeat: u32,
}

pub fn utf16_to_byte(text: &str, offset: u32) -> Option<usize> {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == offset {
            return Some(byte);
        }
        units += ch.len_utf16() as u32;
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(text.len())
}

pub fn classify(sql: &str, dialect: Dialect) -> StmtClass {
    use StmtClass::*;

    let tokens = lex(sql, dialect);
    if tokens
        .last()
        .is_some_and(|token| token.kind == Kind::Unterminated)
    {
        return Unknown;
    }
    let words: Vec<_> = tokens
        .iter()
        .filter(|t| t.kind == Kind::Word)
        .map(|t| t.text(sql).to_ascii_uppercase())
        .collect();
    let word = |i: usize| words.get(i).map(String::as_str).unwrap_or("");
    let class = match word(0) {
        "SELECT" | "WITH" | "TABLE" | "VALUES" | "SHOW" | "EXPLAIN" => {
            let writes = words.iter().any(|w| {
                matches!(
                    w.as_str(),
                    "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "INTO" | "ANALYZE"
                )
            }) || words.windows(2).any(|pair| pair == ["FOR", "SHARE"])
                || words
                    .windows(3)
                    .any(|triple| triple == ["FOR", "KEY", "SHARE"]);
            if writes { Write } else { Read }
        }
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "CALL" | "EXEC" | "EXECUTE" => Write,
        "COPY" if words.iter().any(|w| w == "FROM") => Write,
        "CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "RENAME" | "COMMENT" | "GRANT" | "REVOKE" => Ddl,
        "BEGIN" if dialect == Dialect::Oracle => Procedural,
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "END" => TxControl,
        "SET" | "RESET" | "DISCARD" | "USE" => Session,
        "DECLARE" | "DO" => Procedural,
        _ => Unknown,
    };

    // A read must parse as one recognized read statement. Classification never grants
    // database privileges, and callers must still enforce read-only at the database.
    if class != Read {
        return class;
    }
    let parser: &dyn sqlparser::dialect::Dialect = match dialect {
        Dialect::Postgres => &PostgreSqlDialect {},
        Dialect::SqlServer => &MsSqlDialect {},
        Dialect::Oracle => &OracleDialect {},
    };
    match Parser::new(parser)
        .with_recursion_limit(64)
        .try_with_sql(sql)
        .and_then(|mut parser| parser.parse_statements())
        .as_deref()
    {
        Ok([Statement::Query(_)]) => Read,
        Ok(
            [
                Statement::Explain {
                    analyze: false,
                    statement,
                    ..
                },
            ],
        ) if matches!(statement.as_ref(), Statement::Query(_)) => Read,
        Ok([_]) if word(0) == "SHOW" => Read,
        _ => Unknown,
    }
}

/// In SQL Server, blank lines split cursor blocks only. Scripts are GO-delimited.
pub fn split(text: &str, dialect: Dialect, blank_lines: bool) -> Vec<Span> {
    let tokens = lex(text, dialect);
    let mut spans = Vec::new();
    let mut start = None;
    let mut end = 0;
    let mut parenthesis = 0_u32;
    let mut atomic = 0_u32;
    let mut previous_begin = false;
    let mut oracle_words = Vec::new();
    let mut procedural = false;
    let mut utf16 = 0;
    let mut previous_end = 0;

    let mut emit = |start: Option<usize>, end: usize, repeat: u32| {
        if let Some(start) = start {
            utf16 += text[previous_end..start].encode_utf16().count() as u32;
            let end_utf16 = utf16 + text[start..end].encode_utf16().count() as u32;
            spans.push(Span {
                start: utf16,
                end: end_utf16,
                kind_hint: classify(&text[start..end], dialect),
                repeat,
            });
            utf16 = end_utf16;
            previous_end = end;
        }
    };

    for token in tokens {
        let value = token.text(text);
        let top_level = parenthesis == 0 && atomic == 0;
        let line_delimiter = match token.kind {
            Kind::Batch(repeat) => Some(repeat),
            _ => None,
        };
        let blank = token.kind == Kind::Space
            && blank_lines
            && top_level
            && !procedural
            && value.bytes().enumerate().any(|(i, b)| {
                b == b'\n'
                    && value[i + 1..]
                        .trim_start_matches([' ', '\t', '\r'])
                        .starts_with('\n')
            });
        if line_delimiter.is_some() || blank {
            emit(start.take(), end, line_delimiter.unwrap_or(1));
            parenthesis = 0;
            atomic = 0;
            previous_begin = false;
            oracle_words.clear();
            procedural = false;
            continue;
        }
        if matches!(token.kind, Kind::Space | Kind::Comment) {
            continue;
        }
        if value == ";" && dialect != Dialect::SqlServer && top_level && !procedural {
            if start.is_some() {
                emit(start.take(), token.end, 1);
            }
            oracle_words.clear();
            previous_begin = false;
            continue;
        }
        if value == ";" && start.is_none() {
            continue;
        }
        start.get_or_insert(token.start);
        end = token.end;

        if token.kind == Kind::Word {
            let upper = value.to_ascii_uppercase();
            if dialect == Dialect::Oracle && oracle_words.len() < 8 {
                oracle_words.push(upper.clone());
                let first = oracle_words.first().map(String::as_str);
                procedural = matches!(first, Some("DECLARE" | "BEGIN"))
                    || first == Some("CREATE")
                        && oracle_words
                            .iter()
                            .skip(1)
                            .find(|w| {
                                !matches!(
                                    w.as_str(),
                                    "OR" | "REPLACE" | "EDITIONABLE" | "NONEDITIONABLE"
                                )
                            })
                            .is_some_and(|w| {
                                matches!(
                                    w.as_str(),
                                    "FUNCTION" | "PROCEDURE" | "PACKAGE" | "TRIGGER" | "TYPE"
                                )
                            });
            }
            if dialect == Dialect::Postgres {
                match upper.as_str() {
                    "ATOMIC" if previous_begin && atomic == 0 => atomic = 1,
                    "CASE" | "BEGIN" if atomic > 0 => atomic += 1,
                    "END" if atomic > 0 => atomic -= 1,
                    _ => {}
                }
                previous_begin = upper == "BEGIN";
            }
        } else {
            previous_begin = false;
            match value {
                "(" => parenthesis += 1,
                ")" => parenthesis = parenthesis.saturating_sub(1),
                _ => {}
            }
        }
    }
    emit(start, end, 1);
    spans
}

pub fn statement_at(text: &str, offset: u32, dialect: Dialect, blank_lines: bool) -> Option<Span> {
    utf16_to_byte(text, offset)?;
    let spans = split(text, dialect, blank_lines);
    spans
        .iter()
        .find(|span| span.start <= offset && offset < span.end)
        .cloned()
        .or_else(|| spans.into_iter().rev().find(|span| span.end <= offset))
}

/// A mutation without a predicate needs explicit confirmation in the editor.
pub fn needs_mutation_confirmation(sql: &str) -> bool {
    match Parser::new(&PostgreSqlDialect {})
        .with_recursion_limit(64)
        .try_with_sql(sql)
        .and_then(|mut parser| parser.parse_statements())
        .as_deref()
    {
        Ok([Statement::Update(update)]) => update.selection.is_none(),
        Ok([Statement::Delete(delete)]) => delete.selection.is_none(),
        _ => {
            let mut words = lex(sql, Dialect::Postgres)
                .into_iter()
                .filter(|token| token.kind == Kind::Word)
                .map(|token| token.text(sql));
            let Some(first) = words.next() else {
                return false;
            };
            ["UPDATE", "DELETE"]
                .iter()
                .any(|word| first.eq_ignore_ascii_case(word))
                || (first.eq_ignore_ascii_case("WITH")
                    && words.any(|word| {
                        word.eq_ignore_ascii_case("UPDATE") || word.eq_ignore_ascii_case("DELETE")
                    }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn statements(text: &str, dialect: Dialect, blank_lines: bool) -> Vec<(&str, u32)> {
        split(text, dialect, blank_lines)
            .into_iter()
            .map(|span| {
                let from = utf16_to_byte(text, span.start).expect("start boundary");
                let to = utf16_to_byte(text, span.end).expect("end boundary");
                (&text[from..to], span.repeat)
            })
            .collect()
    }

    #[test]
    fn splitter_matrix_preserves_delimiters_inside_atoms() {
        use Dialect::*;
        let cases = [
            (Postgres, "SELECT 1", ";", "SELECT 'á🤖'"),
            (Postgres, "SELECT 'a;b'", ";", "SELECT 2"),
            (Postgres, "SELECT 'x'';y'", ";", "SELECT 3"),
            (Postgres, r"SELECT E'x\';y'", ";", "SELECT 4"),
            (Postgres, "SELECT $$a;b$$", ";", "SELECT 5"),
            (Postgres, "SELECT $fn$a;b$fn$", ";", "SELECT 6"),
            (Postgres, "SELECT $á$;🤖$á$", ";", "SELECT 7"),
            (
                Postgres,
                "SELECT 1 /* open; /* nested; */ close */ + 2",
                ";",
                "SELECT 8",
            ),
            (Postgres, r#"SELECT "a;""b""#, ";", "SELECT 9"),
            (
                Postgres,
                "CREATE FUNCTION f() RETURNS int LANGUAGE SQL BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; END",
                ";",
                "SELECT 10",
            ),
            (Postgres, "DO $$BEGIN PERFORM 1; END$$", ";", "SELECT 11"),
            (SqlServer, "SELECT [x;]]y]", "\nGO\n", "SELECT 2"),
            (SqlServer, "SELECT N'á\nGO\n🤖'", "\nGO\n", "SELECT 3"),
            (
                SqlServer,
                "SELECT 'GO'; SELECT 6;",
                "\ngo -- batch\n",
                "SELECT 4",
            ),
            (SqlServer, "SELECT 1 /*\nGO\n*/ + 2", "\nGo\n", "SELECT 5"),
            (
                Oracle,
                "SELECT q'[a;b]' FROM dual",
                ";",
                "SELECT 2 FROM dual",
            ),
            (
                Oracle,
                "SELECT q'{a;b}' FROM dual",
                ";",
                "SELECT 3 FROM dual",
            ),
            (
                Oracle,
                "SELECT q'<a;b>' FROM dual",
                ";",
                "SELECT 4 FROM dual",
            ),
            (
                Oracle,
                "SELECT q'!a;b!' FROM dual",
                ";",
                "SELECT 5 FROM dual",
            ),
            (
                Oracle,
                "BEGIN\n NULL;\n\n NULL;\nEND;",
                "\n/\n",
                "SELECT 6 FROM dual",
            ),
            (
                Oracle,
                "CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;",
                "\n/\n",
                "SELECT 7 FROM dual",
            ),
        ];
        let leading = [
            "",
            " ",
            "\r\n",
            "\n\n",
            "-- 👍\n",
            "/* ñ; */ ",
            "\t-- hi\n",
            "/* A */\n/* B */\n",
        ];
        let mut checked = 0;
        for (dialect, first, delimiter, second) in cases {
            for prefix in leading {
                let text = format!("{prefix}{first}{delimiter}{second}");
                let expected = if delimiter == ";" {
                    format!("{first};")
                } else {
                    first.into()
                };
                assert_eq!(
                    statements(&text, dialect, false),
                    [(expected.as_str(), 1), (second, 1)],
                    "{text:?}"
                );
                checked += 1;
            }
        }
        assert_eq!(checked, 168);
    }

    #[test]
    fn cursor_offsets_and_blank_line_blocks() {
        let sql = "SELECT 'á🤖';\n\nSELECT 2";
        let spans = split(sql, Dialect::Postgres, true);
        assert_eq!(
            spans[0].end as usize,
            "SELECT 'á🤖';".encode_utf16().count()
        );
        assert_eq!(
            utf16_to_byte(sql, "SELECT 'á".encode_utf16().count() as u32 + 1),
            None
        );
        assert_eq!(
            statement_at(sql, spans[0].end + 1, Dialect::Postgres, true),
            Some(spans[0].clone())
        );
        assert_eq!(
            statement_at(sql, spans[1].start, Dialect::Postgres, true),
            Some(spans[1].clone())
        );
        assert_eq!(statement_at("-- comment", 0, Dialect::Postgres, true), None);
        assert_eq!(
            statements("SELECT (\n\n1)\n\nSELECT 2", Dialect::Postgres, true).len(),
            2
        );
        assert_eq!(
            statements(
                "SELECT 1\nGO 2 -- twice\nSELECT 2",
                Dialect::SqlServer,
                false
            ),
            [("SELECT 1", 2), ("SELECT 2", 1)]
        );
        assert_eq!(
            statements("SELECT 1;\n\nSELECT 2", Dialect::SqlServer, false).len(),
            1
        );
        assert_eq!(
            statements("SELECT 1;\n\nSELECT 2", Dialect::SqlServer, true).len(),
            2
        );
        assert_eq!(
            statements("BEGIN\nNULL;\n\nNULL;\nEND;", Dialect::Oracle, true).len(),
            1
        );
    }

    #[test]
    fn reads_are_classified_conservatively() {
        use StmtClass::*;
        let cases = [
            ("-- comment\n SELECT 1", Read),
            ("WITH x AS (SELECT 1) SELECT * FROM x", Read),
            (
                "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x",
                Write,
            ),
            ("SELECT * INTO result FROM source", Write),
            ("SELECT * FROM t FOR UPDATE", Write),
            ("SELECT * FROM t FOR SHARE", Write),
            ("EXPLAIN SELECT 1", Read),
            ("EXPLAIN ANALYZE SELECT 1", Write),
            ("EXPLAIN (ANALYZE true) SELECT 1", Write),
            ("EXPLAIN INSERT INTO t VALUES (1)", Write),
            ("SHOW search_path", Read),
            ("VALUES (1)", Read),
            ("SELECT 'DELETE; UPDATE' AS value", Read),
            ("SELECT 'unfinished", Unknown),
            ("SELECT 1 /* unfinished", Unknown),
            ("SELECT (", Unknown),
            ("SELECT 1; SELECT 2", Unknown),
            ("COPY t FROM STDIN", Write),
            ("ALTER TABLE t ADD COLUMN n int", Ddl),
            ("SET search_path TO public", Session),
            ("COMMIT", TxControl),
            ("DO $$ BEGIN NULL; END $$", Procedural),
        ];
        for (value, expected) in cases {
            assert_eq!(classify(value, Dialect::Postgres), expected, "{value:?}");
        }
    }

    #[test]
    fn unterminated_atoms_consume_the_input() {
        for (dialect, value) in [
            (Dialect::Postgres, "SELECT $broken$;\nSELECT 1"),
            (Dialect::Postgres, "SELECT 'broken;\nSELECT 1"),
            (Dialect::Postgres, "SELECT /* broken;\nSELECT 1"),
            (Dialect::Oracle, "SELECT q'[broken;\n/\nSELECT 1"),
            (Dialect::SqlServer, "SELECT [broken\nGO\nSELECT 1"),
        ] {
            let span = split(value, dialect, true);
            assert_eq!(span.len(), 1);
            assert_eq!(span[0].end as usize, value.encode_utf16().count());
            assert_eq!(span[0].kind_hint, StmtClass::Unknown);
        }
    }
}
