use serde::{Deserialize, Serialize};
use crate::config::ChatTemplateType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TurnRole {
    System,
    User,
    Assistant,
}

impl TurnRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

/// Formatter that transforms structured context into the exact prompt string
/// expected by the active model's chat template.
#[derive(Debug, Clone)]
pub struct ChatTemplateRenderer {
    pub template_type: ChatTemplateType,
    pub custom_template: Option<String>,
}

impl ChatTemplateRenderer {
    pub fn new(template_type: ChatTemplateType) -> Self {
        Self {
            template_type,
            custom_template: None,
        }
    }

    pub fn with_custom(template: impl Into<String>) -> Self {
        Self {
            template_type: ChatTemplateType::Custom,
            custom_template: Some(template.into()),
        }
    }

    /// Renders a single message according to the chat template.
    pub fn render_message(&self, role: TurnRole, content: &str) -> String {
        match self.template_type {
            ChatTemplateType::ChatML => {
                format!("<|im_start|>{}\n{}<|im_end|>\n", role.as_str(), content.trim())
            }
            ChatTemplateType::Llama3 => {
                format!(
                    "<|start_header_id|>{}<|end_header_id|>\n\n{}<|eot_id|>",
                    role.as_str(),
                    content.trim()
                )
            }
            ChatTemplateType::Llama2 => match role {
                TurnRole::System => format!("<<SYS>>\n{}\n<</SYS>>\n\n", content.trim()),
                TurnRole::User => format!("[INST] {} [/INST]", content.trim()),
                TurnRole::Assistant => format!(" {} </s>", content.trim()),
            },
            ChatTemplateType::Mistral => match role {
                TurnRole::System => format!("System: {}\n\n", content.trim()),
                TurnRole::User => format!("[INST] {} [/INST]", content.trim()),
                TurnRole::Assistant => format!(" {}</s>", content.trim()),
            },
            ChatTemplateType::Gemma => {
                let role_str = match role {
                    TurnRole::System | TurnRole::User => "user",
                    TurnRole::Assistant => "model",
                };
                format!("<start_of_turn>{}\n{}<end_of_turn>\n", role_str, content.trim())
            }
            ChatTemplateType::Raw | ChatTemplateType::Custom => {
                let role_label = match role {
                    TurnRole::System => "System",
                    TurnRole::User => "User",
                    TurnRole::Assistant => "Assistant",
                };
                format!("{}: {}\n\n", role_label, content.trim())
            }
        }
    }

    /// Renders the prompt suffix that prompts the model to generate the next assistant turn.
    pub fn render_generation_prefix(&self) -> String {
        match self.template_type {
            ChatTemplateType::ChatML => "<|im_start|>assistant\n".to_string(),
            ChatTemplateType::Llama3 => "<|start_header_id|>assistant<|end_header_id|>\n\n".to_string(),
            ChatTemplateType::Llama2 => " ".to_string(),
            ChatTemplateType::Mistral => " ".to_string(),
            ChatTemplateType::Gemma => "<start_of_turn>model\n".to_string(),
            ChatTemplateType::Raw | ChatTemplateType::Custom => "Assistant:\n".to_string(),
        }
    }

    /// Renders a full conversation turn sequence with optional leading system prompt
    /// and trailing assistant prompt prefix.
    pub fn render_full_prompt(
        &self,
        system_content: Option<&str>,
        history: &[(TurnRole, &str)],
        current_user_content: &str,
    ) -> String {
        let mut prompt = String::new();

        match self.template_type {
            ChatTemplateType::ChatML => {
                if let Some(sys) = system_content {
                    if !sys.trim().is_empty() {
                        prompt.push_str(&self.render_message(TurnRole::System, sys));
                    }
                }
                for (role, content) in history {
                    prompt.push_str(&self.render_message(*role, content));
                }
                prompt.push_str(&self.render_message(TurnRole::User, current_user_content));
                prompt.push_str(&self.render_generation_prefix());
            }
            ChatTemplateType::Llama3 => {
                prompt.push_str("<|begin_of_text|>");
                if let Some(sys) = system_content {
                    if !sys.trim().is_empty() {
                        prompt.push_str(&self.render_message(TurnRole::System, sys));
                    }
                }
                for (role, content) in history {
                    prompt.push_str(&self.render_message(*role, content));
                }
                prompt.push_str(&self.render_message(TurnRole::User, current_user_content));
                prompt.push_str(&self.render_generation_prefix());
            }
            ChatTemplateType::Llama2 => {
                let mut combined_first = String::new();
                if let Some(sys) = system_content {
                    if !sys.trim().is_empty() {
                        combined_first.push_str(&format!("<<SYS>>\n{}\n<</SYS>>\n\n", sys.trim()));
                    }
                }

                if history.is_empty() {
                    combined_first.push_str(current_user_content.trim());
                    prompt.push_str(&format!("[INST] {} [/INST]", combined_first));
                } else {
                    let mut is_first = true;
                    for (role, content) in history {
                        match role {
                            TurnRole::User => {
                                if is_first {
                                    combined_first.push_str(content.trim());
                                    prompt.push_str(&format!("[INST] {} [/INST]", combined_first));
                                    is_first = false;
                                } else {
                                    prompt.push_str(&format!("<s>[INST] {} [/INST]", content.trim()));
                                }
                            }
                            TurnRole::Assistant => {
                                prompt.push_str(&format!(" {} </s>", content.trim()));
                            }
                            TurnRole::System => {}
                        }
                    }
                    prompt.push_str(&format!("<s>[INST] {} [/INST]", current_user_content.trim()));
                }
                prompt.push_str(&self.render_generation_prefix());
            }
            ChatTemplateType::Mistral => {
                prompt.push_str("<s>");
                let mut combined_first = String::new();
                if let Some(sys) = system_content {
                    if !sys.trim().is_empty() {
                        combined_first.push_str(&format!("System: {}\n\n", sys.trim()));
                    }
                }

                if history.is_empty() {
                    combined_first.push_str(current_user_content.trim());
                    prompt.push_str(&format!("[INST] {} [/INST]", combined_first));
                } else {
                    let mut is_first = true;
                    for (role, content) in history {
                        match role {
                            TurnRole::User => {
                                if is_first {
                                    combined_first.push_str(content.trim());
                                    prompt.push_str(&format!("[INST] {} [/INST]", combined_first));
                                    is_first = false;
                                } else {
                                    prompt.push_str(&format!("[INST] {} [/INST]", content.trim()));
                                }
                            }
                            TurnRole::Assistant => {
                                prompt.push_str(&format!(" {}</s>", content.trim()));
                            }
                            TurnRole::System => {}
                        }
                    }
                    prompt.push_str(&format!("[INST] {} [/INST]", current_user_content.trim()));
                }
            }
            ChatTemplateType::Gemma => {
                if let Some(sys) = system_content {
                    if !sys.trim().is_empty() {
                        prompt.push_str(&format!("<start_of_turn>user\nSystem instructions:\n{}<end_of_turn>\n", sys.trim()));
                    }
                }
                for (role, content) in history {
                    prompt.push_str(&self.render_message(*role, content));
                }
                prompt.push_str(&self.render_message(TurnRole::User, current_user_content));
                prompt.push_str(&self.render_generation_prefix());
            }
            ChatTemplateType::Raw | ChatTemplateType::Custom => {
                if let Some(sys) = system_content {
                    if !sys.trim().is_empty() {
                        prompt.push_str(&format!("System: {}\n\n", sys.trim()));
                    }
                }
                for (role, content) in history {
                    prompt.push_str(&self.render_message(*role, content));
                }
                prompt.push_str(&format!("User: {}\n\n", current_user_content.trim()));
                prompt.push_str(&self.render_generation_prefix());
            }
        }

        prompt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chatml_full_prompt() {
        let renderer = ChatTemplateRenderer::new(ChatTemplateType::ChatML);
        let prompt = renderer.render_full_prompt(
            Some("You are LowCon."),
            &[(TurnRole::User, "Hello"), (TurnRole::Assistant, "Hi there")],
            "Can you help me?",
        );

        assert!(prompt.contains("<|im_start|>system\nYou are LowCon.<|im_end|>\n"));
        assert!(prompt.contains("<|im_start|>user\nHello<|im_end|>\n"));
        assert!(prompt.contains("<|im_start|>assistant\nHi there<|im_end|>\n"));
        assert!(prompt.contains("<|im_start|>user\nCan you help me?<|im_end|>\n"));
        assert!(prompt.ends_with("<|im_start|>assistant\n"));
    }

    #[test]
    fn test_llama3_full_prompt() {
        let renderer = ChatTemplateRenderer::new(ChatTemplateType::Llama3);
        let prompt = renderer.render_full_prompt(
            Some("System prompt"),
            &[],
            "User question",
        );

        assert!(prompt.starts_with("<|begin_of_text|>"));
        assert!(prompt.contains("<|start_header_id|>system<|end_header_id|>\n\nSystem prompt<|eot_id|>"));
        assert!(prompt.contains("<|start_header_id|>user<|end_header_id|>\n\nUser question<|eot_id|>"));
        assert!(prompt.ends_with("<|start_header_id|>assistant<|end_header_id|>\n\n"));
    }
}
