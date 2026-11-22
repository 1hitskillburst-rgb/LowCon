use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DiagnosticLevel {
    Disabled,
    MinimalRedacted,
    DebugRedacted,
}

impl Default for DiagnosticLevel {
    fn default() -> Self {
        Self::Disabled
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticEntry {
    pub timestamp: i64,
    pub level: String,
    pub module: String,
    pub message: String,
}

/// Thread-safe in-memory diagnostic logger enforcing strict local-only redaction policies.
#[derive(Debug, Clone)]
pub struct DiagnosticLogger {
    level: Arc<Mutex<DiagnosticLevel>>,
    buffer: Arc<Mutex<Vec<DiagnosticEntry>>>,
    max_entries: usize,
}

impl DiagnosticLogger {
    pub fn new(level: DiagnosticLevel) -> Self {
        Self {
            level: Arc::new(Mutex::new(level)),
            buffer: Arc::new(Mutex::new(Vec::new())),
            max_entries: 500,
        }
    }

    pub fn set_level(&self, level: DiagnosticLevel) {
        if let Ok(mut l) = self.level.lock() {
            *l = level;
        }
    }

    pub fn get_level(&self) -> DiagnosticLevel {
        self.level.lock().map(|l| *l).unwrap_or(DiagnosticLevel::Disabled)
    }

    /// Redacts known sensitive patterns such as conversation content, prompts, tokens, or credentials.
    pub fn sanitize(input: &str) -> String {
        let mut text = input.to_string();

        // Specific pattern replacements
        let sensitive_prefixes = [
            "password=",
            "password:",
            "prompt:",
            "user_message:",
            "assistant_response:",
            "content:",
            "memory_text:",
        ];

        for prefix in sensitive_prefixes {
            if let Some(pos) = text.to_lowercase().find(prefix) {
                let start = pos + prefix.len();
                let end = text[start..].find('\n').map(|idx| start + idx).unwrap_or(text.len());
                let replacement = format!("{} [REDACTED]", &text[pos..start]);
                text.replace_range(pos..end, &replacement);
            }
        }

        // Generic keyword scrubber
        let keywords = ["bearer ", "token=", "api_key=", "secret="];
        for kw in keywords {
            if let Some(pos) = text.to_lowercase().find(kw) {
                let start = pos + kw.len();
                let end = text[start..].find(|c: char| c.is_whitespace() || c == ',' || c == '&')
                    .map(|idx| start + idx)
                    .unwrap_or(text.len());
                text.replace_range(start..end, "[REDACTED]");
            }
        }

        text
    }

    pub fn log(&self, level_str: &str, module: &str, raw_message: &str) {
        let current_level = self.get_level();
        if current_level == DiagnosticLevel::Disabled {
            return;
        }

        let sanitized = Self::sanitize(raw_message);
        let entry = DiagnosticEntry {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            level: level_str.to_uppercase(),
            module: module.to_string(),
            message: sanitized,
        };

        if let Ok(mut buf) = self.buffer.lock() {
            if buf.len() >= self.max_entries {
                buf.remove(0);
            }
            buf.push(entry);
        }
    }

    pub fn info(&self, module: &str, message: &str) {
        self.log("INFO", module, message);
    }

    pub fn warn(&self, module: &str, message: &str) {
        self.log("WARN", module, message);
    }

    pub fn error(&self, module: &str, message: &str) {
        self.log("ERROR", module, message);
    }

    pub fn get_entries(&self) -> Vec<DiagnosticEntry> {
        self.buffer.lock().map(|b| b.clone()).unwrap_or_default()
    }

    pub fn clear(&self) {
        if let Ok(mut buf) = self.buffer.lock() {
            buf.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diagnostics_disabled_by_default() {
        let logger = DiagnosticLogger::new(DiagnosticLevel::Disabled);
        logger.info("core", "Diagnostic message");
        assert!(logger.get_entries().is_empty());
    }

    #[test]
    fn test_diagnostics_redaction() {
        let logger = DiagnosticLogger::new(DiagnosticLevel::MinimalRedacted);
        logger.info("context", "Loading prompt: Hello user secret");
        logger.info("auth", "Setting password=MySuperSecretPassword123");
        logger.warn("network", "Attempt with token=ghp_secrettoken123456");

        let entries = logger.get_entries();
        assert_eq!(entries.len(), 3);

        assert!(!entries[0].message.contains("Hello user secret"));
        assert!(entries[0].message.contains("[REDACTED]"));

        assert!(!entries[1].message.contains("MySuperSecretPassword123"));
        assert!(entries[1].message.contains("[REDACTED]"));

        assert!(!entries[2].message.contains("ghp_secrettoken123456"));
        assert!(entries[2].message.contains("[REDACTED]"));
    }
}
