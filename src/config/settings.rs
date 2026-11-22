use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::config::error::ConfigError;
use crate::privacy::DiagnosticLevel;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BudgetPartition {
    pub model_limit: usize,
    pub prompt_budget: usize,
    pub output_reserve: usize,
    pub safety_margin: usize,
}

impl BudgetPartition {
    pub fn verify_invariant(&self) -> bool {
        self.prompt_budget + self.output_reserve + self.safety_margin <= self.model_limit
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppSettings {
    pub storage_dir: PathBuf,
    pub default_context_limit: usize,
    pub output_reserve_percent: u8,
    pub safety_margin_percent: u8,
    pub enable_memory_retrieval: bool,
    pub retrieval_limit: usize,
    pub diagnostic_level: DiagnosticLevel,
    pub vault_enabled: bool,
    pub active_profile_id: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        let storage_dir = default_storage_dir();
        Self {
            storage_dir,
            default_context_limit: 2048,
            output_reserve_percent: 20,
            safety_margin_percent: 5,
            enable_memory_retrieval: true,
            retrieval_limit: 5,
            diagnostic_level: DiagnosticLevel::Disabled,
            vault_enabled: false,
            active_profile_id: None,
        }
    }
}

pub fn default_storage_dir() -> PathBuf {
    if let Ok(app_data) = std::env::var("APPDATA") {
        PathBuf::from(app_data).join("LowCon")
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".local").join("share").join("lowcon")
    } else {
        PathBuf::from("./lowcon_data")
    }
}

impl AppSettings {
    pub fn validate(&self) -> Result<(), ConfigError> {
        let total_reserves = self.output_reserve_percent as usize + self.safety_margin_percent as usize;
        if total_reserves >= 100 {
            return Err(ConfigError::InvalidBudgetPercentages {
                reserve: self.output_reserve_percent,
                safety: self.safety_margin_percent,
            });
        }
        if self.default_context_limit < 256 {
            return Err(ConfigError::ContextLimitTooSmall {
                requested: self.default_context_limit,
                minimum: 256,
            });
        }
        Ok(())
    }

    /// Computes the exact deterministic budget partition for any model context capacity.
    /// Invariant: prompt_budget + output_reserve + safety_margin <= model_limit.
    pub fn calculate_budget(&self, model_context_limit: usize) -> Result<BudgetPartition, ConfigError> {
        self.validate()?;

        if model_context_limit < 256 {
            return Err(ConfigError::ContextLimitTooSmall {
                requested: model_context_limit,
                minimum: 256,
            });
        }

        let output_reserve = (model_context_limit * self.output_reserve_percent as usize) / 100;
        let safety_margin = (model_context_limit * self.safety_margin_percent as usize) / 100;
        let prompt_budget = model_context_limit.saturating_sub(output_reserve + safety_margin);

        let partition = BudgetPartition {
            model_limit: model_context_limit,
            prompt_budget,
            output_reserve,
            safety_margin,
        };

        debug_assert!(partition.verify_invariant(), "Budget invariant violated");
        Ok(partition)
    }

    pub fn load_from_json(json_str: &str) -> Result<Self, ConfigError> {
        let settings: Self = serde_json::from_str(json_str)
            .map_err(|e| ConfigError::SerializationError(e.to_string()))?;
        settings.validate()?;
        Ok(settings)
    }

    pub fn to_json(&self) -> Result<String, ConfigError> {
        self.validate()?;
        serde_json::to_string_pretty(self)
            .map_err(|e| ConfigError::SerializationError(e.to_string()))
    }

    pub fn load_from_file(path: &Path) -> Result<Self, ConfigError> {
        let content = std::fs::read_to_string(path)
            .map_err(|e| ConfigError::IoError(e.to_string()))?;
        Self::load_from_json(&content)
    }

    pub fn save_to_file(&self, path: &Path) -> Result<(), ConfigError> {
        let json = self.to_json()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ConfigError::IoError(e.to_string()))?;
        }
        std::fs::write(path, json)
            .map_err(|e| ConfigError::IoError(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_budget_partition_invariants() {
        let settings = AppSettings::default(); // 20% output, 5% safety margin
        assert_eq!(settings.output_reserve_percent, 20);
        assert_eq!(settings.safety_margin_percent, 5);

        for &limit in &[2048, 4096, 8192, 16384, 32768] {
            let partition = settings.calculate_budget(limit).expect("Calculation failed");
            assert!(partition.verify_invariant());
            assert_eq!(partition.model_limit, limit);
            assert_eq!(partition.output_reserve, limit * 20 / 100);
            assert_eq!(partition.safety_margin, limit * 5 / 100);
            assert_eq!(partition.prompt_budget, limit - partition.output_reserve - partition.safety_margin);
        }
    }

    #[test]
    fn test_invalid_settings() {
        let mut settings = AppSettings::default();
        settings.output_reserve_percent = 70;
        settings.safety_margin_percent = 35; // 105% >= 100%
        assert!(settings.validate().is_err());

        settings.safety_margin_percent = 5;
        settings.default_context_limit = 100; // < 256
        assert!(settings.validate().is_err());
    }

    #[test]
    fn test_json_roundtrip() {
        let settings = AppSettings::default();
        let json = settings.to_json().expect("Failed to serialize");
        let restored = AppSettings::load_from_json(&json).expect("Failed to deserialize");
        assert_eq!(settings, restored);
    }
}
