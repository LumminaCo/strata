use crate::Dialect;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Kind {
    Space,
    Comment,
    Word,
    Quoted,
    Symbol,
    Batch(u32),
    Unterminated,
}

pub(crate) struct Token {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
}

impl Token {
    pub fn text<'a>(&self, text: &'a str) -> &'a str {
        &text[self.start..self.end]
    }
}

fn is_word(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '_' | '$' | '#')
}

fn quoted(input: &str, quote: char, escapes: bool) -> Option<usize> {
    let mut chars = input.char_indices().peekable();
    while let Some((offset, ch)) = chars.next() {
        if ch == '\\' && escapes {
            chars.next();
        } else if ch == quote {
            if chars.peek().is_some_and(|(_, next)| *next == quote) {
                chars.next();
            } else {
                return Some(offset + ch.len_utf8());
            }
        }
    }
    None
}

fn block_comment(text: &str, nested: bool) -> Option<usize> {
    let mut depth = 1;
    let mut offset = 2;
    while offset + 1 < text.len() {
        match &text.as_bytes()[offset..offset + 2] {
            b"/*" if nested => {
                depth += 1;
                offset += 2;
            }
            b"*/" => {
                depth -= 1;
                offset += 2;
                if depth == 0 {
                    return Some(offset);
                }
            }
            _ => offset += 1,
        }
    }
    None
}

fn delimiter(from: &str, dialect: Dialect) -> Option<(usize, u32)> {
    let first = from.as_bytes()[0];
    if !matches!(
        (dialect, first),
        (Dialect::SqlServer, b'G' | b'g') | (Dialect::Oracle, b'/')
    ) {
        return None;
    }
    let line_end = from.find('\n').unwrap_or(from.len());
    let line = from[..line_end].split("--").next()?.trim();
    if dialect == Dialect::Oracle {
        return (line == "/").then_some((line_end, 1));
    }
    let mut words = line.split_whitespace();
    if !words.next()?.eq_ignore_ascii_case("GO") {
        return None;
    }
    let count = match words.next() {
        None => 1,
        Some(value) => value.parse::<u32>().ok().filter(|v| *v > 0)?,
    };
    words.next().is_none().then_some((line_end, count))
}

fn lex_token(rest: &str, dialect: Dialect, line_start: bool) -> (Kind, usize) {
    use Kind::*;
    let mut chars = rest.chars();
    let Some(ch) = chars.next() else {
        return (Space, 0);
    };
    let closed = |len: Option<usize>, kind| len.map_or((Unterminated, rest.len()), |n| (kind, n));
    if ch.is_whitespace() {
        return (
            Space,
            rest.find(|c: char| !c.is_whitespace())
                .unwrap_or(rest.len()),
        );
    }
    if line_start && let Some((len, repeat)) = delimiter(rest, dialect) {
        return (Batch(repeat), len);
    }
    if rest.starts_with("--") {
        return (Comment, rest.find('\n').unwrap_or(rest.len()));
    }
    if rest.starts_with("/*") {
        return closed(block_comment(rest, dialect != Dialect::Oracle), Comment);
    }
    if ch == '$'
        && dialect == Dialect::Postgres
        && let Some(size) = rest[1..].find(|c: char| !(c.is_alphanumeric() || c == '_'))
        && rest.as_bytes()[1 + size] == b'$'
        && !rest.as_bytes()[1].is_ascii_digit()
    {
        let marker_len = size + 2;
        let marker = &rest[..marker_len];
        return closed(
            rest[marker_len..].find(marker).map(|n| n + 2 * marker_len),
            Quoted,
        );
    }
    if dialect == Dialect::Oracle
        && matches!(ch, 'q' | 'Q')
        && let Some(tail) = rest.get(1..).and_then(|r| r.strip_prefix('\''))
        && let Some(open) = tail.chars().next()
    {
        let close = match open {
            '[' => ']',
            '(' => ')',
            '{' => '}',
            '<' => '>',
            _ => open,
        };
        let marker = format!("{close}'");
        return closed(
            tail[open.len_utf8()..]
                .find(&marker)
                .map(|n| 2 + open.len_utf8() + n + marker.len()),
            Quoted,
        );
    }
    let prefix = match (dialect, ch) {
        (Dialect::Postgres, 'e' | 'E') if rest.as_bytes().get(1) == Some(&b'\'') => 2,
        (Dialect::SqlServer, 'n' | 'N') if rest.as_bytes().get(1) == Some(&b'\'') => 2,
        (_, '\'' | '"') => 1,
        (Dialect::SqlServer, '[') => 1,
        _ => 0,
    };
    if prefix != 0 {
        let quote = match ch {
            '[' => ']',
            '"' => '"',
            _ => '\'',
        };
        return closed(
            quoted(
                &rest[prefix..],
                quote,
                dialect == Dialect::Postgres && prefix == 2,
            )
            .map(|n| n + prefix),
            Quoted,
        );
    }
    if is_word(ch) {
        return (Word, rest.find(|c: char| !is_word(c)).unwrap_or(rest.len()));
    }
    (Symbol, ch.len_utf8())
}

pub(crate) fn lex(text: &str, dialect: Dialect) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut start = 0;
    let mut line_start = true;
    while start < text.len() {
        let (kind, len) = lex_token(&text[start..], dialect, line_start);
        let end = start + len;
        if let Some((_, trailing)) = text[start..end].rsplit_once('\n') {
            line_start = trailing.trim().is_empty();
        } else if kind != Kind::Space {
            line_start = false;
        }
        tokens.push(Token { kind, start, end });
        start = end;
    }
    tokens
}
