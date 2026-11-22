/// Cleans and sanitizes a user query into a safe SQLite FTS5 MATCH expression.
/// Strips punctuation and syntax operators, tokenizes words, and formats as prefix or quoted terms.
pub fn sanitize_fts5_query(input: &str) -> Option<String> {
    let tokens: Vec<String> = input
        .split(|c: char| {
            c.is_whitespace()
                || c == '"'
                || c == '*'
                || c == ':'
                || c == '('
                || c == ')'
                || c == '^'
                || c == '{'
                || c == '}'
                || c == '+'
                || c == '~'
                || c == '?'
                || c == '!'
                || c == ';'
                || c == ','
                || c == '.'
        })
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        // Ignore reserved FTS5 boolean operator words to avoid syntax errors
        .filter(|w| !w.eq_ignore_ascii_case("AND") && !w.eq_ignore_ascii_case("OR") && !w.eq_ignore_ascii_case("NOT") && !w.eq_ignore_ascii_case("NEAR"))
        .map(|w| {
            let escaped = w.replace('"', "\"\"");
            format!("\"{}\"*", escaped)
        })
        .collect();

    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" OR "))
    }
}

/// Builds an exact phrase or AND-conjoined FTS5 query.
pub fn sanitize_fts5_and_query(input: &str) -> Option<String> {
    let tokens: Vec<String> = input
        .split(|c: char| {
            c.is_whitespace()
                || c == '"'
                || c == '*'
                || c == ':'
                || c == '('
                || c == ')'
                || c == '^'
                || c == '{'
                || c == '}'
        })
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .filter(|w| !w.eq_ignore_ascii_case("AND") && !w.eq_ignore_ascii_case("OR") && !w.eq_ignore_ascii_case("NOT"))
        .map(|w| {
            let escaped = w.replace('"', "\"\"");
            format!("\"{}\"", escaped)
        })
        .collect();

    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_empty_and_whitespace() {
        assert_eq!(sanitize_fts5_query(""), None);
        assert_eq!(sanitize_fts5_query("   "), None);
        assert_eq!(sanitize_fts5_query("***:::"), None);
    }

    #[test]
    fn test_sanitize_special_characters() {
        let q = sanitize_fts5_query("Rust: (ownership) OR \"borrowing\"*!");
        assert!(q.is_some());
        let res = q.unwrap();
        assert!(res.contains("\"Rust\"*"));
        assert!(res.contains("\"ownership\"*"));
        assert!(res.contains("\"borrowing\"*"));
        assert!(!res.contains("OR*"));
    }

    #[test]
    fn test_sanitize_and_query() {
        let q = sanitize_fts5_and_query("local offline model");
        assert_eq!(q, Some("\"local\" \"offline\" \"model\"".to_string()));
    }
}
