use std::sync::Arc;
use crate::config::ChatTemplateType;
use crate::context::budget::ContextBudgetCalculator;
use crate::context::candidate::{
    AssemblyCandidates, ConversationTurn, CoreInstruction, CurrentUserMessage, MemoryExcerpt,
    PinnedFact, SummaryExcerpt, TaskState,
};
use crate::context::error::ContextError;
use crate::context::inspector::{
    CandidateKind, ExcludedCandidate, IncludedItem, PromptInspection, SectionTokenBreakdown,
};
use crate::context::template::{ChatTemplateRenderer, TurnRole};
use crate::context::tokenizer::Tokenizer;

/// The Budget-First Context Assembly Engine.
///
/// Implements Section 4 of the LowCon Architecture:
/// - Invariant enforcement: prompt_tokens + max_output_tokens + safety_margin <= model_context_limit.
/// - Stable priority-based assembly (Core -> User message -> Pinned facts -> Task state -> Memory -> Newest turns -> Summaries).
/// - Deterministic 4-stage overflow trimming.
/// - Strict protection: NEVER silently truncates current user message, core instructions, or pinned items.
/// - Full Prompt Inspector output with per-section token breakdown and explainable exclusion reasons.
#[derive(Debug, Clone)]
pub struct ContextAssemblyEngine {
    budget_calculator: ContextBudgetCalculator,
    tokenizer: Arc<dyn Tokenizer>,
    template_type: ChatTemplateType,
}

impl ContextAssemblyEngine {
    pub fn new(
        budget_calculator: ContextBudgetCalculator,
        tokenizer: Arc<dyn Tokenizer>,
        template_type: ChatTemplateType,
    ) -> Self {
        Self {
            budget_calculator,
            tokenizer,
            template_type,
        }
    }

    pub fn with_defaults(tokenizer: Arc<dyn Tokenizer>, template_type: ChatTemplateType) -> Self {
        Self {
            budget_calculator: ContextBudgetCalculator::with_default_config(),
            tokenizer,
            template_type,
        }
    }

    pub fn tokenizer(&self) -> &dyn Tokenizer {
        self.tokenizer.as_ref()
    }

    pub fn template_type(&self) -> ChatTemplateType {
        self.template_type
    }

    pub fn budget_calculator(&self) -> &ContextBudgetCalculator {
        &self.budget_calculator
    }

    /// Assembles context deterministically according to strict budget and priority rules.
    pub fn assemble(
        &self,
        candidates: AssemblyCandidates,
        model_context_limit: usize,
    ) -> Result<PromptInspection, ContextError> {
        // 1. Calculate budget partition and verify invariant
        let partition = self.budget_calculator.calculate(model_context_limit)?;
        let prompt_budget = partition.prompt_budget;

        // 2. Validate mandatory current user message
        let user_msg = match &candidates.current_user_message {
            Some(msg) if !msg.content.trim().is_empty() => msg.clone(),
            _ => return Err(ContextError::EmptyUserMessage),
        };

        let core_instruction = candidates
            .core_instruction
            .unwrap_or_default();

        let renderer = ChatTemplateRenderer::new(self.template_type);

        // 3. Prepare working candidate pools
        let included_pinned_facts = candidates.pinned_facts.clone();
        let active_task_state = candidates.task_state.clone();
        let mut working_memories = candidates.retrieved_memories.clone();
        let mut working_turns = candidates.conversation_turns.clone();
        let mut working_summaries = candidates.summaries.clone();

        let mut use_compact_summaries = false;
        let mut include_metadata = true;
        let mut excluded_candidates: Vec<ExcludedCandidate> = Vec::new();

        // Sort memories: pinned first, then highest relevance score first
        working_memories.sort_by(|a, b| {
            b.is_pinned
                .cmp(&a.is_pinned)
                .then_with(|| b.relevance_score.partial_cmp(&a.relevance_score).unwrap_or(std::cmp::Ordering::Equal))
        });

        // 4. Initial render test
        let mut current_prompt = render_prompt(
            &renderer,
            &core_instruction,
            &included_pinned_facts,
            &active_task_state,
            &working_memories,
            &working_summaries,
            use_compact_summaries,
            &working_turns,
            &user_msg,
            include_metadata,
        );
        let mut current_tokens = self.tokenizer.count_tokens(&current_prompt);

        // 5. Overflow Trimming Stages (if prompt exceeds budget)

        // Stage 1: Trim lowest-ranked unpinned retrieval results
        while current_tokens > prompt_budget {
            let unpinned_idx = working_memories
                .iter()
                .rposition(|m| !m.is_pinned);

            match unpinned_idx {
                Some(idx) => {
                    let removed = working_memories.remove(idx);
                    let est_tokens = self.tokenizer.count_tokens(&removed.format_for_prompt());
                    excluded_candidates.push(ExcludedCandidate {
                        id: removed.id.clone(),
                        kind: CandidateKind::RetrievedMemory,
                        label: format!("Memory Note: {}", removed.title),
                        estimated_tokens: est_tokens,
                        reason: format!(
                            "Trimmed during Stage 1 overflow pass: unpinned memory note (relevance score {:.2}) excluded to fit {} token budget",
                            removed.relevance_score, prompt_budget
                        ),
                    });

                    current_prompt = render_prompt(
                        &renderer,
                        &core_instruction,
                        &included_pinned_facts,
                        &active_task_state,
                        &working_memories,
                        &working_summaries,
                        use_compact_summaries,
                        &working_turns,
                        &user_msg,
                        include_metadata,
                    );
                    current_tokens = self.tokenizer.count_tokens(&current_prompt);
                }
                None => break, // No more unpinned memories to trim
            }
        }

        // Stage 2: Reduce optional summaries (first compact, then remove unpinned)
        if current_tokens > prompt_budget && !working_summaries.is_empty() && !use_compact_summaries {
            use_compact_summaries = true;
            current_prompt = render_prompt(
                &renderer,
                &core_instruction,
                &included_pinned_facts,
                &active_task_state,
                &working_memories,
                &working_summaries,
                use_compact_summaries,
                &working_turns,
                &user_msg,
                include_metadata,
            );
            current_tokens = self.tokenizer.count_tokens(&current_prompt);
        }

        while current_tokens > prompt_budget {
            let unpinned_sum_idx = working_summaries
                .iter()
                .rposition(|s| !s.is_pinned);

            match unpinned_sum_idx {
                Some(idx) => {
                    let removed = working_summaries.remove(idx);
                    let est_tokens = self.tokenizer.count_tokens(&removed.format_for_prompt(use_compact_summaries));
                    excluded_candidates.push(ExcludedCandidate {
                        id: removed.id.clone(),
                        kind: CandidateKind::Summary,
                        label: format!("Summary (Turns {})", removed.source_turn_range),
                        estimated_tokens: est_tokens,
                        reason: format!(
                            "Trimmed during Stage 2 overflow pass: unpinned summary removed to fit {} token budget",
                            prompt_budget
                        ),
                    });

                    current_prompt = render_prompt(
                        &renderer,
                        &core_instruction,
                        &included_pinned_facts,
                        &active_task_state,
                        &working_memories,
                        &working_summaries,
                        use_compact_summaries,
                        &working_turns,
                        &user_msg,
                        include_metadata,
                    );
                    current_tokens = self.tokenizer.count_tokens(&current_prompt);
                }
                None => break,
            }
        }

        // Stage 3: Remove oldest unpinned conversation turns
        while current_tokens > prompt_budget {
            let oldest_unpinned_idx = working_turns
                .iter()
                .position(|t| !t.is_pinned);

            match oldest_unpinned_idx {
                Some(idx) => {
                    let removed = working_turns.remove(idx);
                    let est_tokens = self.tokenizer.count_tokens(&removed.content);
                    excluded_candidates.push(ExcludedCandidate {
                        id: removed.id.clone(),
                        kind: CandidateKind::ConversationTurn,
                        label: format!("Turn #{}: {}...", removed.id, removed.content.chars().take(24).collect::<String>()),
                        estimated_tokens: est_tokens,
                        reason: format!(
                            "Trimmed during Stage 3 overflow pass: oldest unpinned turn removed to preserve newer turns within {} token budget",
                            prompt_budget
                        ),
                    });

                    current_prompt = render_prompt(
                        &renderer,
                        &core_instruction,
                        &included_pinned_facts,
                        &active_task_state,
                        &working_memories,
                        &working_summaries,
                        use_compact_summaries,
                        &working_turns,
                        &user_msg,
                        include_metadata,
                    );
                    current_tokens = self.tokenizer.count_tokens(&current_prompt);
                }
                None => break,
            }
        }

        // Stage 4: Remove optional metadata
        if current_tokens > prompt_budget && include_metadata {
            include_metadata = false;
            excluded_candidates.push(ExcludedCandidate {
                id: "metadata".to_string(),
                kind: CandidateKind::Metadata,
                label: "Non-essential Context Metadata".to_string(),
                estimated_tokens: 16,
                reason: "Trimmed during Stage 4 overflow pass: metadata stripped to fit prompt budget".to_string(),
            });

            current_prompt = render_prompt(
                &renderer,
                &core_instruction,
                &included_pinned_facts,
                &active_task_state,
                &working_memories,
                &working_summaries,
                use_compact_summaries,
                &working_turns,
                &user_msg,
                include_metadata,
            );
            current_tokens = self.tokenizer.count_tokens(&current_prompt);
        }

        // Stage 5: Mandatory Content Verification
        // If mandatory content (Core + Pinned Facts + Current User Message + Task State + Chat template)
        // still exceeds the prompt budget, we NEVER truncate them!
        // We must return an explicit, actionable error explaining the exact limit.
        if current_tokens > prompt_budget {
            let core_tokens = self.tokenizer.count_tokens(&core_instruction.text);
            let user_tokens = self.tokenizer.count_tokens(&user_msg.content);
            let pinned_tokens: usize = included_pinned_facts
                .iter()
                .map(|f| self.tokenizer.count_tokens(&format!("{}: {}", f.title, f.content)))
                .sum();

            return Err(ContextError::MandatoryContentExceedsBudget {
                required: current_tokens,
                budget: prompt_budget,
                breakdown: format!(
                    "Mandatory content requires {} tokens (User message: {}, Core instructions: {}, Pinned facts: {}) but prompt budget is only {} tokens (Model limit: {}, Output reserve: {}, Safety margin: {}). Please shorten the message or increase context settings.",
                    current_tokens,
                    user_tokens,
                    core_tokens,
                    pinned_tokens,
                    prompt_budget,
                    partition.model_limit,
                    partition.output_reserve,
                    partition.safety_margin
                ),
            });
        }

        // 6. Detailed Token Breakdown and Included Items Accounting
        let (sections, included_items) = self.calculate_sections_and_included_items(
            &renderer,
            &core_instruction,
            &included_pinned_facts,
            &active_task_state,
            &working_memories,
            &working_summaries,
            use_compact_summaries,
            &working_turns,
            &user_msg,
            current_tokens,
        );

        let remaining_capacity = prompt_budget.saturating_sub(current_tokens);

        Ok(PromptInspection {
            exact_rendered_prompt: current_prompt,
            total_tokens: current_tokens,
            is_exact_count: self.tokenizer.is_exact(),
            tokenizer_name: self.tokenizer.name().to_string(),
            budget_partition: partition,
            remaining_capacity,
            sections,
            included_items,
            excluded_candidates,
        })
    }

    /// Calculate section token counts and build the list of included items.
    fn calculate_sections_and_included_items(
        &self,
        renderer: &ChatTemplateRenderer,
        core: &CoreInstruction,
        pinned_facts: &[PinnedFact],
        task_state: &Option<TaskState>,
        memories: &[MemoryExcerpt],
        summaries: &[SummaryExcerpt],
        use_compact_summaries: bool,
        turns: &[ConversationTurn],
        user_msg: &CurrentUserMessage,
        total_prompt_tokens: usize,
    ) -> (Vec<SectionTokenBreakdown>, Vec<IncludedItem>) {
        let mut sections = Vec::new();
        let mut included = Vec::new();

        // 1. Core System Instructions
        let core_tokens = self.tokenizer.count_tokens(&core.text);
        sections.push(SectionTokenBreakdown {
            name: "Core System Instructions".to_string(),
            tokens: core_tokens,
            description: "Immutable baseline instructions".to_string(),
        });
        included.push(IncludedItem {
            id: "core_instruction".to_string(),
            kind: CandidateKind::CoreInstruction,
            label: "Core system prompt".to_string(),
            tokens: core_tokens,
            source_ref: None,
        });

        // 2. Pinned Facts & Rules
        if !pinned_facts.is_empty() {
            let mut pinned_text = String::new();
            for f in pinned_facts {
                pinned_text.push_str(&format!("{}: {}\n", f.title, f.content));
            }
            let pinned_tokens = self.tokenizer.count_tokens(&pinned_text);
            sections.push(SectionTokenBreakdown {
                name: "Pinned Facts & Rules".to_string(),
                tokens: pinned_tokens,
                description: format!("{} user-pinned constraints", pinned_facts.len()),
            });

            for f in pinned_facts {
                let tok = self.tokenizer.count_tokens(&format!("{}: {}", f.title, f.content));
                included.push(IncludedItem {
                    id: f.id.clone(),
                    kind: CandidateKind::PinnedFact,
                    label: f.title.clone(),
                    tokens: tok,
                    source_ref: f.source_reference.clone(),
                });
            }
        }

        // 3. Active Task State
        if let Some(task) = task_state {
            if !task.is_empty() {
                let formatted = task.format_compact();
                let task_tokens = self.tokenizer.count_tokens(&formatted);
                sections.push(SectionTokenBreakdown {
                    name: "Active Task State".to_string(),
                    tokens: task_tokens,
                    description: "Goals, constraints, and unresolved questions".to_string(),
                });
                included.push(IncludedItem {
                    id: "task_state".to_string(),
                    kind: CandidateKind::TaskState,
                    label: "Compact task state".to_string(),
                    tokens: task_tokens,
                    source_ref: None,
                });
            }
        }

        // 4. Retrieved Memory
        if !memories.is_empty() {
            let mut mem_text = String::new();
            for m in memories {
                mem_text.push_str(&m.format_for_prompt());
                mem_text.push('\n');
            }
            let mem_tokens = self.tokenizer.count_tokens(&mem_text);
            sections.push(SectionTokenBreakdown {
                name: format!("Retrieved Memory ({} notes)", memories.len()),
                tokens: mem_tokens,
                description: "Exact excerpts from local SQLite FTS5".to_string(),
            });

            for m in memories {
                let tok = self.tokenizer.count_tokens(&m.format_for_prompt());
                included.push(IncludedItem {
                    id: m.id.clone(),
                    kind: CandidateKind::RetrievedMemory,
                    label: m.title.clone(),
                    tokens: tok,
                    source_ref: m.source_message_id.clone(),
                });
            }
        }

        // 5. Turn Summaries
        if !summaries.is_empty() {
            let mut sum_text = String::new();
            for s in summaries {
                sum_text.push_str(&s.format_for_prompt(use_compact_summaries));
                sum_text.push('\n');
            }
            let sum_tokens = self.tokenizer.count_tokens(&sum_text);
            sections.push(SectionTokenBreakdown {
                name: "Turn Summaries".to_string(),
                tokens: sum_tokens,
                description: format!("{} compact summaries of older history", summaries.len()),
            });

            for s in summaries {
                let tok = self.tokenizer.count_tokens(&s.format_for_prompt(use_compact_summaries));
                included.push(IncludedItem {
                    id: s.id.clone(),
                    kind: CandidateKind::Summary,
                    label: format!("Summary (Turns {})", s.source_turn_range),
                    tokens: tok,
                    source_ref: None,
                });
            }
        }

        // 6. Recent Conversation Turns
        if !turns.is_empty() {
            let mut turns_text = String::new();
            for t in turns {
                turns_text.push_str(&t.content);
                turns_text.push('\n');
            }
            let turns_tokens = self.tokenizer.count_tokens(&turns_text);
            sections.push(SectionTokenBreakdown {
                name: "Recent Conversation Turns".to_string(),
                tokens: turns_tokens,
                description: format!("{} newest message turns", turns.len()),
            });

            for t in turns {
                let tok = self.tokenizer.count_tokens(&t.content);
                included.push(IncludedItem {
                    id: t.id.clone(),
                    kind: CandidateKind::ConversationTurn,
                    label: format!("Turn #{}: {}", t.id, t.role.as_str()),
                    tokens: tok,
                    source_ref: None,
                });
            }
        }

        // 7. Current User Message
        let user_tokens = self.tokenizer.count_tokens(&user_msg.content);
        sections.push(SectionTokenBreakdown {
            name: "Current User Message".to_string(),
            tokens: user_tokens,
            description: "Preserved completely without truncation".to_string(),
        });
        included.push(IncludedItem {
            id: "current_user_message".to_string(),
            kind: CandidateKind::CurrentUserMessage,
            label: "User message".to_string(),
            tokens: user_tokens,
            source_ref: None,
        });

        // 8. Template overhead
        let content_sum: usize = sections.iter().map(|s| s.tokens).sum();
        let template_overhead = total_prompt_tokens.saturating_sub(content_sum);
        sections.push(SectionTokenBreakdown {
            name: "Chat Template Syntax".to_string(),
            tokens: template_overhead,
            description: format!("Formatting tags for {:?}", renderer.template_type),
        });

        (sections, included)
    }
}

/// Helper function to build and render the full prompt string.
fn render_prompt(
    renderer: &ChatTemplateRenderer,
    core: &CoreInstruction,
    pinned_facts: &[PinnedFact],
    task_state: &Option<TaskState>,
    memories: &[MemoryExcerpt],
    summaries: &[SummaryExcerpt],
    use_compact_summaries: bool,
    turns: &[ConversationTurn],
    user_msg: &CurrentUserMessage,
    include_metadata: bool,
) -> String {
    let mut system_text = core.text.clone();

    if !pinned_facts.is_empty() {
        system_text.push_str("\n\n[Pinned Instructions & Facts]");
        for fact in pinned_facts {
            system_text.push_str(&format!("\n- {}: {}", fact.title, fact.content));
        }
    }

    if let Some(task) = task_state {
        let task_compact = task.format_compact();
        if !task_compact.is_empty() {
            system_text.push_str("\n\n");
            system_text.push_str(&task_compact);
        }
    }

    if !memories.is_empty() {
        system_text.push_str("\n\n[Retrieved Memory]");
        for mem in memories {
            system_text.push_str(&format!("\n- {}", mem.format_for_prompt()));
        }
    }

    if !summaries.is_empty() {
        system_text.push_str("\n\n[Earlier History Summaries]");
        for sum in summaries {
            system_text.push_str(&format!("\n- {}", sum.format_for_prompt(use_compact_summaries)));
        }
    }

    let rendered_turns: Vec<(TurnRole, &str)> = turns
        .iter()
        .map(|t| (t.role, t.content.as_str()))
        .collect();

    let mut user_content = user_msg.content.clone();
    if include_metadata {
        if let Some(meta) = &user_msg.metadata {
            user_content.push_str(&format!("\n[Context Metadata: {}]", meta));
        }
    }

    renderer.render_full_prompt(Some(&system_text), &rendered_turns, &user_content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::tokenizer::ExactMockTokenizer;

    #[test]
    fn test_engine_basic_assembly() {
        let tokenizer = Arc::new(ExactMockTokenizer::chatml());
        let engine = ContextAssemblyEngine::with_defaults(tokenizer, ChatTemplateType::ChatML);

        let candidates = AssemblyCandidates {
            core_instruction: Some(CoreInstruction::default()),
            current_user_message: Some(CurrentUserMessage::new("How do I write Rust tests?")),
            pinned_facts: vec![PinnedFact {
                id: "pin1".into(),
                title: "Rule".into(),
                content: "Keep answers concise".into(),
                source_reference: None,
            }],
            ..Default::default()
        };

        let result = engine.assemble(candidates, 2048).expect("Assembly should succeed");

        assert!(result.total_tokens <= result.budget_partition.prompt_budget);
        assert!(result.budget_partition.verify_invariant());
        assert!(result.exact_rendered_prompt.contains("How do I write Rust tests?"));
        assert!(result.exact_rendered_prompt.contains("Keep answers concise"));
        assert_eq!(result.included_items.len(), 3); // core, pinned fact, user message
    }
}
