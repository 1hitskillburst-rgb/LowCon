use thiserror::Error;

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    #[error("Invalid budget percentages: output reserve ({reserve}%) + safety margin ({safety}%) must be < 100%")]
    InvalidBudgetPercentages { reserve: u8, safety: u8 },

    #[error("Context limit too small: requested {requested}, minimum required is {minimum}")]
    ContextLimitTooSmall { requested: usize, minimum: usize },

    #[error("Serialization error: {0}")]
    SerializationError(String),

    #[error("IO error: {0}")]
    IoError(String),
}
