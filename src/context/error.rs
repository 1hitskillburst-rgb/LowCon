use thiserror::Error;

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum ContextError {
    #[error("Mandatory prompt content ({required} tokens) exceeds prompt budget ({budget} tokens). {breakdown}")]
    MandatoryContentExceedsBudget {
        required: usize,
        budget: usize,
        breakdown: String,
    },

    #[error("Current user message cannot be empty")]
    EmptyUserMessage,

    #[error("Invalid budget configuration: {0}")]
    InvalidBudgetConfiguration(String),

    #[error("Template rendering error: {0}")]
    TemplateRenderError(String),
}
