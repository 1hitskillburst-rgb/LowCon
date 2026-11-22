use serde::{Deserialize, Serialize};
use crate::config::BudgetPartition;
use crate::context::error::ContextError;

/// Configuration for context budget partitioning.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BudgetConfig {
    /// Percentage of model context reserved for model output generation (default 20%).
    pub output_reserve_percent: u8,
    /// Percentage of model context reserved as safety cushion (default 5%).
    pub safety_margin_percent: u8,
    /// Minimum output tokens guaranteed even on tiny context limits.
    pub min_output_tokens: usize,
    /// Minimum safety margin guaranteed.
    pub min_safety_tokens: usize,
}

impl Default for BudgetConfig {
    fn default() -> Self {
        Self {
            output_reserve_percent: 20,
            safety_margin_percent: 5,
            min_output_tokens: 64,
            min_safety_tokens: 16,
        }
    }
}

/// Token budget calculator enforcing the strict mathematical invariant:
/// `prompt_tokens + max_output_tokens + safety_margin <= model_context_limit`
#[derive(Debug, Clone)]
pub struct ContextBudgetCalculator {
    config: BudgetConfig,
}

impl ContextBudgetCalculator {
    pub fn new(config: BudgetConfig) -> Result<Self, ContextError> {
        let total_pct = config.output_reserve_percent as usize + config.safety_margin_percent as usize;
        if total_pct >= 100 {
            return Err(ContextError::InvalidBudgetConfiguration(format!(
                "Total reserve and safety percentage ({total_pct}%) must be less than 100%"
            )));
        }
        Ok(Self { config })
    }

    pub fn with_default_config() -> Self {
        Self {
            config: BudgetConfig::default(),
        }
    }

    pub fn config(&self) -> &BudgetConfig {
        &self.config
    }

    /// Compute partition for a specific model context limit.
    /// Invariant: `prompt_budget + output_reserve + safety_margin <= model_limit`
    pub fn calculate(&self, model_context_limit: usize) -> Result<BudgetPartition, ContextError> {
        if model_context_limit < 128 {
            return Err(ContextError::InvalidBudgetConfiguration(format!(
                "Context limit ({model_context_limit}) is too small (minimum 128 tokens required)"
            )));
        }

        let mut output_reserve = (model_context_limit * self.config.output_reserve_percent as usize) / 100;
        let mut safety_margin = (model_context_limit * self.config.safety_margin_percent as usize) / 100;

        // Apply minimum floor reserves if context limit allows
        if model_context_limit >= 512 {
            output_reserve = output_reserve.max(self.config.min_output_tokens);
            safety_margin = safety_margin.max(self.config.min_safety_tokens);
        }

        // Ensure reserves do not swallow entire context
        let total_reserved = output_reserve + safety_margin;
        if total_reserved >= model_context_limit {
            return Err(ContextError::InvalidBudgetConfiguration(format!(
                "Total reserves ({total_reserved}) exceed model context limit ({model_context_limit})"
            )));
        }

        let prompt_budget = model_context_limit.saturating_sub(total_reserved);

        let partition = BudgetPartition {
            model_limit: model_context_limit,
            prompt_budget,
            output_reserve,
            safety_margin,
        };

        // Assert strictly the non-negotiable invariant
        debug_assert!(
            partition.verify_invariant(),
            "Context budget invariant violated: prompt_budget({}) + output_reserve({}) + safety_margin({}) > model_limit({})",
            partition.prompt_budget,
            partition.output_reserve,
            partition.safety_margin,
            partition.model_limit
        );

        Ok(partition)
    }

    /// Validates whether a given prompt token count satisfies the model limit invariant.
    pub fn verify_prompt_fits(
        partition: &BudgetPartition,
        prompt_tokens: usize,
    ) -> Result<(), ContextError> {
        let total = prompt_tokens + partition.output_reserve + partition.safety_margin;
        if total > partition.model_limit {
            Err(ContextError::MandatoryContentExceedsBudget {
                required: prompt_tokens,
                budget: partition.prompt_budget,
                breakdown: format!(
                    "Prompt tokens ({prompt_tokens}) + output reserve ({}) + safety margin ({}) = {} tokens, which exceeds model limit {}",
                    partition.output_reserve,
                    partition.safety_margin,
                    total,
                    partition.model_limit
                ),
            })
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_budget_invariant_standard_limits() {
        let calculator = ContextBudgetCalculator::with_default_config();

        for &limit in &[2048, 4096, 8192, 16384, 32768] {
            let partition = calculator.calculate(limit).expect("Calculation should succeed");
            assert!(partition.verify_invariant());
            assert_eq!(partition.model_limit, limit);
            assert_eq!(partition.output_reserve, limit * 20 / 100);
            assert_eq!(partition.safety_margin, limit * 5 / 100);
            assert_eq!(
                partition.prompt_budget,
                limit - partition.output_reserve - partition.safety_margin
            );
            assert!(
                ContextBudgetCalculator::verify_prompt_fits(&partition, partition.prompt_budget)
                    .is_ok()
            );
            assert!(
                ContextBudgetCalculator::verify_prompt_fits(
                    &partition,
                    partition.prompt_budget + 1
                )
                .is_err()
            );
        }
    }

    #[test]
    fn test_budget_configurable_percentages() {
        let config = BudgetConfig {
            output_reserve_percent: 25,
            safety_margin_percent: 10,
            min_output_tokens: 32,
            min_safety_tokens: 16,
        };
        let calculator = ContextBudgetCalculator::new(config).unwrap();
        let partition = calculator.calculate(4096).unwrap();

        assert_eq!(partition.output_reserve, 1024);
        assert_eq!(partition.safety_margin, 409);
        assert_eq!(partition.prompt_budget, 4096 - 1024 - 409);
        assert!(partition.verify_invariant());
    }

    #[test]
    fn test_invalid_percentages_rejected() {
        let config = BudgetConfig {
            output_reserve_percent: 80,
            safety_margin_percent: 25,
            min_output_tokens: 0,
            min_safety_tokens: 0,
        };
        assert!(ContextBudgetCalculator::new(config).is_err());
    }
}
