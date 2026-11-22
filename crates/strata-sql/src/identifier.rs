use crate::{
    Dialect,
    lexer::{Kind, Token, lex},
    statement_at, utf16_to_byte,
};

#[derive(Debug, PartialEq)]
pub struct RelationAt {
    pub parts: Vec<String>,
    pub column: Option<String>,
    pub from: u32,
    pub to: u32,
}

/// Find a catalog name at a UTF-16 editor offset, honoring the statement's table aliases.
pub fn relation_at(text: &str, offset: u32, dialect: Dialect) -> Option<RelationAt> {
    let span = statement_at(text, offset, dialect, false)?;
    if offset < span.start || offset > span.end {
        return None;
    }
    let sql = &text[utf16_to_byte(text, span.start)?..utf16_to_byte(text, span.end)?];
    let cursor = utf16_to_byte(sql, offset - span.start)?;
    let tokens: Vec<_> = lex(sql, dialect)
        .into_iter()
        .filter(|token| !matches!(token.kind, Kind::Space | Kind::Comment))
        .collect();
    let at = tokens
        .iter()
        .position(|token| token.start <= cursor && cursor < token.end)
        .or_else(|| tokens.iter().rposition(|token| token.end == cursor))?;
    if part(&tokens[at], sql, dialect).is_none() && tokens[at].text(sql) != "." {
        return None;
    }
    let mut first = at;
    while first > 0
        && tokens[first - 1].text(sql) == "."
        && first >= 2
        && part(&tokens[first - 2], sql, dialect).is_some()
    {
        first -= 2;
    }
    if tokens[first].text(sql) == "." && first > 0 {
        first -= 1;
    }
    let (parts, end) = path(&tokens, first, sql, dialect)?;
    let from = span.start + sql[..tokens[first].start].encode_utf16().count() as u32;
    let to = span.start + sql[..tokens[end - 1].end].encode_utf16().count() as u32;
    let mut relation = RelationAt {
        parts,
        column: None,
        from,
        to,
    };

    let mut at = 0;
    while at < tokens.len() {
        let word = tokens[at].text(sql);
        at += 1;
        if !["FROM", "JOIN", "UPDATE", "INTO"]
            .iter()
            .any(|keyword| word.eq_ignore_ascii_case(keyword))
        {
            continue;
        }
        let Some((table, end)) = path(&tokens, at, sql, dialect) else {
            continue;
        };
        at = end;
        if tokens
            .get(at)
            .is_some_and(|token| token.text(sql).eq_ignore_ascii_case("AS"))
        {
            at += 1;
        }
        let Some(alias) = tokens.get(at).and_then(|token| part(token, sql, dialect)) else {
            continue;
        };
        if [
            "where",
            "group",
            "join",
            "left",
            "right",
            "inner",
            "outer",
            "full",
            "on",
            "order",
            "limit",
            "offset",
            "using",
            "cross",
            "fetch",
            "having",
            "returning",
            "union",
            "set",
            "values",
        ]
        .iter()
        .any(|keyword| alias.eq_ignore_ascii_case(keyword))
        {
            continue;
        }
        if relation.parts.first().is_some_and(|name| name == &alias) && relation.parts.len() <= 2 {
            relation.column = relation.parts.get(1).cloned();
            relation.parts = table;
            break;
        }
    }
    Some(relation)
}

fn path(
    tokens: &[Token],
    start: usize,
    text: &str,
    dialect: Dialect,
) -> Option<(Vec<String>, usize)> {
    let mut parts = vec![part(tokens.get(start)?, text, dialect)?];
    let mut end = start + 1;
    while parts.len() < 3 && tokens.get(end).is_some_and(|token| token.text(text) == ".") {
        let Some(name) = tokens
            .get(end + 1)
            .and_then(|token| part(token, text, dialect))
        else {
            break;
        };
        parts.push(name);
        end += 2;
    }
    Some((parts, end))
}

fn part(token: &Token, text: &str, dialect: Dialect) -> Option<String> {
    let value = token.text(text);
    match token.kind {
        Kind::Word => Some(match dialect {
            Dialect::Postgres => value.to_ascii_lowercase(),
            Dialect::SqlServer => value.into(),
            Dialect::Oracle => value.to_ascii_uppercase(),
        }),
        Kind::Quoted if value.starts_with('"') => {
            Some(value[1..value.len() - 1].replace("\"\"", "\""))
        }
        Kind::Quoted if dialect == Dialect::SqlServer && value.starts_with('[') => {
            Some(value[1..value.len() - 1].replace("]]", "]"))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_quoted_alias_and_utf16_span() {
        let sql = "SELECT '🪨', u.email FROM public.\"Users\" AS u";
        let at = sql[..sql.find("email").unwrap()].encode_utf16().count() as u32;
        let relation = relation_at(sql, at, Dialect::Postgres).unwrap();
        assert_eq!(relation.parts, ["public", "Users"]);
        assert_eq!(relation.column.as_deref(), Some("email"));
        assert_eq!(relation.to - relation.from, 7);
        assert!(relation_at(sql, 9, Dialect::Postgres).is_none());
    }
}
