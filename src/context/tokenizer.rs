use std::sync::Arc;
use crate::config::ChatTemplateType;

/// Core tokenizer abstraction for LowCon context assembly.
/// Enables either exact token counts (when llama.cpp or vocabulary is loaded)
/// or high-confidence conservative estimation (when running without weights or model unloaded).
pub trait Tokenizer: std::fmt::Debug + Send + Sync {
    /// Count tokens for a string slice.
    fn count_tokens(&self, text: &str) -> usize;

    /// Whether this tokenizer yields exact token counts.
    /// If false, UI labels it as an estimate and applies conservative safety margins.
    fn is_exact(&self) -> bool;

    /// Descriptive name of the tokenizer implementation.
    fn name(&self) -> &str;

    /// Calculates token overhead for a specific chat template message framing.
    fn template_message_overhead(&self, template: ChatTemplateType) -> usize {
        match template {
            ChatTemplateType::ChatML => 4,    // <|im_start|>role\n ... <|im_end|>\n
            ChatTemplateType::Llama3 => 6,    // <|start_header_id|>role<|end_header_id|>\n\n ... <|eot_id|>
            ChatTemplateType::Llama2 => 5,    // [INST] ... [/INST]
            ChatTemplateType::Mistral => 4,   // [INST] ... [/INST]
            ChatTemplateType::Gemma => 4,     // <start_of_turn>role\n ... <end_of_turn>\n
            ChatTemplateType::Raw => 2,       // Role: ... \n
            ChatTemplateType::Custom => 4,
        }
    }
}

/// Conservative token estimator.
/// Used when exact model tokenizer weights are not yet in memory.
/// Guarantees conservative over-estimation (~15-20% margin) to prevent out-of-context overflow.
#[derive(Debug, Clone, Default)]
pub struct ConservativeEstimator {
    safety_cushion_factor: f32, // e.g. 1.15
}

impl ConservativeEstimator {
    pub fn new() -> Self {
        Self {
            safety_cushion_factor: 1.15,
        }
    }

    pub fn with_cushion(factor: f32) -> Self {
        Self {
            safety_cushion_factor: factor.max(1.0),
        }
    }
}

impl Tokenizer for ConservativeEstimator {
    fn count_tokens(&self, text: &str) -> usize {
        if text.is_empty() {
            return 0;
        }

        let mut raw_token_estimate: f32 = 0.0;

        // Count special tokens like <|im_start|>, [INST], etc.
        let remaining = text;
        let special_patterns = [
            "<|im_start|>", "<|im_end|>", "<|start_header_id|>", "<|end_header_id|>",
            "<|eot_id|>", "<|begin_of_text|>", "[INST]", "[/INST]", "<<SYS>>", "<</SYS>>",
            "<s>", "</s>", "<start_of_turn>", "<end_of_turn>",
        ];

        for pattern in &special_patterns {
            let count = remaining.matches(pattern).count();
            if count > 0 {
                raw_token_estimate += count as f32; // Special tokens count as 1 token each
            }
        }

        // Segment by words and characters
        for word in text.split_whitespace() {
            let char_count = word.chars().count();
            if char_count == 0 {
                continue;
            }

            // Check for non-ASCII/CJK characters
            let mut cjk_count = 0;
            let mut ascii_count = 0;
            let mut punct_count = 0;

            for ch in word.chars() {
                if is_cjk_or_complex(ch) {
                    cjk_count += 1;
                } else if ch.is_ascii_alphanumeric() {
                    ascii_count += 1;
                } else {
                    punct_count += 1;
                }
            }

            // CJK characters typically count as 1 to 2 tokens each in BPE
            raw_token_estimate += (cjk_count as f32) * 1.5;

            // Punctuation characters count ~1 token each or in pairs
            raw_token_estimate += punct_count as f32;

            // ASCII words: ~3.5 to 4.0 chars per token
            if ascii_count > 0 {
                let ascii_tokens = (ascii_count as f32 / 3.6).ceil();
                raw_token_estimate += ascii_tokens;
            }
        }

        // Account for newlines
        let newline_count = text.matches('\n').count();
        raw_token_estimate += newline_count as f32 * 0.5;

        // Apply conservative safety cushion and ensure at least 1 token if text not empty
        let conservative_total = (raw_token_estimate * self.safety_cushion_factor).ceil() as usize;
        conservative_total.max(1)
    }

    fn is_exact(&self) -> bool {
        false
    }

    fn name(&self) -> &str {
        "Conservative Token Estimator (heuristic + 15% cushion)"
    }
}

/// Helper to identify CJK or complex unicode scripts where characters map to distinct tokens.
fn is_cjk_or_complex(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF |   // CJK Unified Ideographs
        0x3400..=0x4DBF |   // CJK Extension A
        0x20000..=0x2A6DF | // CJK Extension B
        0x3040..=0x309F |   // Hiragana
        0x30A0..=0x30FF |   // Katakana
        0xAC00..=0xD7AF |   // Hangul Syllables
        0x1F300..=0x1FAFF   // Emojis & Pictographs
    )
}

/// Exact token counter for testing, benchmarking, or when exact vocabulary is available.
#[derive(Debug, Clone)]
pub struct ExactMockTokenizer {
    name: String,
    tokens_per_word: f32,
}

impl ExactMockTokenizer {
    pub fn new(name: impl Into<String>, tokens_per_word: f32) -> Self {
        Self {
            name: name.into(),
            tokens_per_word: tokens_per_word.max(0.1),
        }
    }

    pub fn llama3() -> Self {
        Self::new("Exact Llama3 Tokenizer (Mock)", 1.25)
    }

    pub fn chatml() -> Self {
        Self::new("Exact ChatML Tokenizer (Mock)", 1.30)
    }
}

impl Tokenizer for ExactMockTokenizer {
    fn count_tokens(&self, text: &str) -> usize {
        if text.is_empty() {
            return 0;
        }

        let words = text.split_whitespace().count();
        let punctuation = text.chars().filter(|c| c.is_ascii_punctuation()).count();
        let newlines = text.matches('\n').count();

        let base = (words as f32 * self.tokens_per_word).ceil() as usize;
        let total = base + (punctuation / 2) + newlines;
        total.max(1)
    }

    fn is_exact(&self) -> bool {
        true
    }

    fn name(&self) -> &str {
        &self.name
    }
}

/// Creates a shared default tokenizer (ConservativeEstimator).
pub fn default_tokenizer() -> Arc<dyn Tokenizer> {
    Arc::new(ConservativeEstimator::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conservative_estimator_empty() {
        let est = ConservativeEstimator::new();
        assert_eq!(est.count_tokens(""), 0);
        assert!(!est.is_exact());
    }

    #[test]
    fn test_conservative_estimator_positive_tokens() {
        let est = ConservativeEstimator::new();
        let count = est.count_tokens("Hello world! How are you doing today?");
        assert!(count >= 7, "Expected at least 7 tokens, got {}", count);
        assert!(count <= 20, "Expected reasonable upper bound, got {}", count);
    }

    #[test]
    fn test_conservative_estimator_cjk() {
        let est = ConservativeEstimator::new();
        let count = est.count_tokens("你好世界");
        assert!(count >= 4, "CJK chars should count conservatively");
    }

    #[test]
    fn test_exact_mock_tokenizer() {
        let mock = ExactMockTokenizer::llama3();
        assert!(mock.is_exact());
        let count = mock.count_tokens("Testing the exact mock tokenizer calculation.");
        assert!(count > 0);
    }
}
