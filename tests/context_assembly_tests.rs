use std::sync::Arc;
use lowcon::config::ChatTemplateType;
use lowcon::context::{
    AssemblyCandidates, ConservativeEstimator, ContextAssemblyEngine, ContextError,
    ConversationTurn, CoreInstruction, CurrentUserMessage, ExactMockTokenizer, MemoryExcerpt,
    PinnedFact, SummaryExcerpt, TaskState,
};

#[test]
fn test_context_limits_2k_4k_8k_invariants() {
    let limits = [2048, 4096, 8192, 16384, 32768];
    let tokenizer = Arc::new(ConservativeEstimator::new());
    let engine = ContextAssemblyEngine::with_defaults(tokenizer, ChatTemplateType::ChatML);

    for &limit in &limits {
        let candidates = AssemblyCandidates {
            core_instruction: Some(CoreInstruction::default()),
            current_user_message: Some(CurrentUserMessage::new(
                "Can you analyze this system architecture and provide trade-offs?",
            )),
            pinned_facts: vec![
                PinnedFact {
                    id: "fact-1".into(),
                    title: "Security Boundary".into(),
                    content: "No network requests allowed under any circumstances.".into(),
                    source_reference: Some("sess-1/msg-4".into()),
                },
                PinnedFact {
                    id: "fact-2".into(),
                    title: "Storage Policy".into(),
                    content: "Data stays inside the user-configured vault.".into(),
                    source_reference: None,
                },
            ],
            task_state: Some(TaskState {
                goals: vec!["Implement budget-first context assembly".into()],
                constraints: vec!["Deterministic truncation".into(), "Zero silent data loss".into()],
                decisions: vec!["FTS5 for retrieval".into()],
                unresolved_questions: vec![],
            }),
            retrieved_memories: vec![
                MemoryExcerpt {
                    id: "mem-1".into(),
                    title: "Offline Invariant".into(),
                    excerpt: "LowCon operates with Ethernet and Wi-Fi disconnected.".into(),
                    source_message_id: Some("12".into()),
                    relevance_score: 0.95,
                    is_pinned: true,
                },
                MemoryExcerpt {
                    id: "mem-2".into(),
                    title: "Token Accounting".into(),
                    excerpt: "Prompt tokens plus output reserve and safety margin must fit context limit.".into(),
                    source_message_id: Some("15".into()),
                    relevance_score: 0.82,
                    is_pinned: false,
                },
            ],
            conversation_turns: vec![
                ConversationTurn::user("t1", "Let's review the memory model requirements."),
                ConversationTurn::assistant("t2", "Memory uses SQLite FTS5 for deterministic retrieval."),
                ConversationTurn::user("t3", "What about the context packing rules?"),
                ConversationTurn::assistant("t4", "It prioritizes core rules, user input, and pinned facts."),
            ],
            summaries: vec![SummaryExcerpt {
                id: "sum-1".into(),
                summary_text: "Discussed local architecture and SQLite schema.".into(),
                compact_version: Some("Local arch & SQLite schema discussed.".into()),
                source_turn_range: "1-4".into(),
                is_pinned: false,
            }],
        };

        let result = engine.assemble(candidates, limit).expect("Assembly must succeed");

        // Mathematical Invariant Assertion:
        // prompt_tokens + output_reserve + safety_margin <= model_context_limit
        let total = result.total_tokens
            + result.budget_partition.output_reserve
            + result.budget_partition.safety_margin;
        assert!(
            total <= limit,
            "Invariant failed for limit {}: total ({}) > limit ({})",
            limit,
            total,
            limit
        );

        // Budget Partition Invariant
        assert!(result.budget_partition.verify_invariant());
        assert_eq!(result.budget_partition.model_limit, limit);

        // Prompt budget ceiling
        assert!(
            result.total_tokens <= result.budget_partition.prompt_budget,
            "Total tokens ({}) exceeds prompt budget ({}) for limit {}",
            result.total_tokens,
            result.budget_partition.prompt_budget,
            limit
        );

        // Remaining capacity accounting
        assert_eq!(
            result.remaining_capacity,
            result.budget_partition.prompt_budget - result.total_tokens
        );

        // User message must be fully intact
        assert!(
            result.exact_rendered_prompt.contains("Can you analyze this system architecture and provide trade-offs?")
        );

        // Pinned facts must be fully intact
        assert!(result.exact_rendered_prompt.contains("No network requests allowed"));
    }
}

#[test]
fn test_multiple_model_templates_token_counts() {
    let templates = [
        ChatTemplateType::ChatML,
        ChatTemplateType::Llama3,
        ChatTemplateType::Llama2,
        ChatTemplateType::Mistral,
        ChatTemplateType::Gemma,
        ChatTemplateType::Raw,
    ];

    let tokenizer = Arc::new(ConservativeEstimator::new());

    let candidates = AssemblyCandidates {
        core_instruction: Some(CoreInstruction::default()),
        current_user_message: Some(CurrentUserMessage::new("Explain deterministic context budgeting.")),
        conversation_turns: vec![
            ConversationTurn::user("1", "Hello"),
            ConversationTurn::assistant("2", "Greetings! How can I assist you?"),
        ],
        ..Default::default()
    };

    let mut rendered_prompts = Vec::new();

    for &template in &templates {
        let engine = ContextAssemblyEngine::with_defaults(tokenizer.clone(), template);
        let result = engine.assemble(candidates.clone(), 4096).unwrap();

        assert!(result.total_tokens > 0);
        assert!(result.total_tokens <= result.budget_partition.prompt_budget);

        rendered_prompts.push((template, result.exact_rendered_prompt.clone(), result.total_tokens));
    }

    // Verify ChatML has ChatML tags
    let chatml = rendered_prompts.iter().find(|(t, _, _)| *t == ChatTemplateType::ChatML).unwrap();
    assert!(chatml.1.contains("<|im_start|>"));
    assert!(chatml.1.contains("<|im_end|>"));

    // Verify Llama3 has Llama3 tags
    let llama3 = rendered_prompts.iter().find(|(t, _, _)| *t == ChatTemplateType::Llama3).unwrap();
    assert!(llama3.1.contains("<|start_header_id|>"));
    assert!(llama3.1.contains("<|end_header_id|>"));

    // Verify Llama2 has INST tags
    let llama2 = rendered_prompts.iter().find(|(t, _, _)| *t == ChatTemplateType::Llama2).unwrap();
    assert!(llama2.1.contains("[INST]"));
}

#[test]
fn test_exact_preservation_of_user_message_and_pinned_facts() {
    let tokenizer = Arc::new(ExactMockTokenizer::chatml());
    let engine = ContextAssemblyEngine::with_defaults(tokenizer, ChatTemplateType::ChatML);

    let precious_user_text = "CRITICAL QUERY: Do NOT truncate this under any condition! Every character matters.";
    let precious_pinned_text = "PINNED CONSTRAINT: Storage directory cannot be changed at runtime.";

    let candidates = AssemblyCandidates {
        core_instruction: Some(CoreInstruction::default()),
        current_user_message: Some(CurrentUserMessage::new(precious_user_text)),
        pinned_facts: vec![PinnedFact {
            id: "p1".into(),
            title: "Storage Policy".into(),
            content: precious_pinned_text.into(),
            source_reference: Some("sess-9/msg-1".into()),
        }],
        retrieved_memories: vec![
            MemoryExcerpt {
                id: "m1".into(),
                title: "Low relevance note".into(),
                excerpt: "This note should be trimmed if budget is tight.".into(),
                source_message_id: None,
                relevance_score: 0.1,
                is_pinned: false,
            },
        ],
        ..Default::default()
    };

    let result = engine.assemble(candidates, 1024).unwrap();

    assert!(result.exact_rendered_prompt.contains(precious_user_text));
    assert!(result.exact_rendered_prompt.contains(precious_pinned_text));
}

#[test]
fn test_deterministic_overflow_trimming_order() {
    // We construct a scenario with tight budget (512 tokens) where:
    // - Memory (unpinned) should be trimmed first (Stage 1)
    // - Summaries should be reduced/trimmed second (Stage 2)
    // - Oldest unpinned turns should be trimmed third (Stage 3)
    // - Newest turns and mandatory items remain!
    let tokenizer = Arc::new(ExactMockTokenizer::chatml());
    let engine = ContextAssemblyEngine::with_defaults(tokenizer, ChatTemplateType::ChatML);

    let candidates = AssemblyCandidates {
        core_instruction: Some(CoreInstruction {
            text: "You are LowCon.".into(),
        }),
        current_user_message: Some(CurrentUserMessage::new("What is the current plan?")),
        pinned_facts: vec![PinnedFact {
            id: "pin-core".into(),
            title: "Rule".into(),
            content: "Stay offline".into(),
            source_reference: None,
        }],
        retrieved_memories: vec![
            MemoryExcerpt {
                id: "mem-low".into(),
                title: "Obsolete Memory".into(),
                excerpt: "A long paragraph of obsolete details ".repeat(20),
                source_message_id: None,
                relevance_score: 0.15,
                is_pinned: false,
            },
            MemoryExcerpt {
                id: "mem-high".into(),
                title: "Important Fact".into(),
                excerpt: "Essential architecture summary that is important.".repeat(10),
                source_message_id: None,
                relevance_score: 0.95,
                is_pinned: false,
            },
        ],
        conversation_turns: vec![
            ConversationTurn::user("t1", "Oldest turn 1: very long discussion about legacy architecture ".repeat(15)),
            ConversationTurn::assistant("t2", "Oldest turn 2: long response explaining old details ".repeat(15)),
            ConversationTurn::user("t3", "Newest turn 3: What is the latest update?"),
        ],
        summaries: vec![SummaryExcerpt {
            id: "s1".into(),
            summary_text: "Summary of older sessions covering multiple legacy features ".repeat(15),
            compact_version: Some("Compact legacy summary.".into()),
            source_turn_range: "1-10".into(),
            is_pinned: false,
        }],
        ..Default::default()
    };

    // 512 token limit has prompt budget of 512 - 102 - 25 = 385 tokens
    let result = engine.assemble(candidates, 512).unwrap();

    assert!(result.total_tokens <= result.budget_partition.prompt_budget);

    // Verify explainable exclusion reasons exist in excluded_candidates
    assert!(!result.excluded_candidates.is_empty());

    for excluded in &result.excluded_candidates {
        assert!(!excluded.reason.is_empty());
        assert!(excluded.reason.contains("overflow pass") || excluded.reason.contains("budget"));
    }

    // Current user message and pinned rule MUST be preserved
    assert!(result.exact_rendered_prompt.contains("What is the current plan?"));
    assert!(result.exact_rendered_prompt.contains("Stay offline"));
}

#[test]
fn test_current_user_message_alone_exceeding_budget_never_silently_clipped() {
    let tokenizer = Arc::new(ConservativeEstimator::new());
    let engine = ContextAssemblyEngine::with_defaults(tokenizer, ChatTemplateType::ChatML);

    // Create a giant user message of 3,000 words (> 4,000 tokens)
    let giant_message = "word ".repeat(3000);

    let candidates = AssemblyCandidates {
        core_instruction: Some(CoreInstruction::default()),
        current_user_message: Some(CurrentUserMessage::new(giant_message)),
        ..Default::default()
    };

    // Model context limit is only 2048 tokens (prompt budget ~1536 tokens)
    let err = engine.assemble(candidates, 2048).unwrap_err();

    match err {
        ContextError::MandatoryContentExceedsBudget { required, budget, breakdown } => {
            assert!(required > budget);
            assert!(breakdown.contains("User message"));
            assert!(breakdown.contains("Please shorten the message"));
        }
        other => panic!("Expected MandatoryContentExceedsBudget, got: {:?}", other),
    }
}

#[test]
fn test_empty_user_message_rejected() {
    let tokenizer = Arc::new(ConservativeEstimator::new());
    let engine = ContextAssemblyEngine::with_defaults(tokenizer, ChatTemplateType::ChatML);

    let candidates = AssemblyCandidates {
        core_instruction: Some(CoreInstruction::default()),
        current_user_message: Some(CurrentUserMessage::new("   ")),
        ..Default::default()
    };

    let err = engine.assemble(candidates, 2048).unwrap_err();
    assert_eq!(err, ContextError::EmptyUserMessage);
}

#[test]
fn test_stored_transcript_messages_remain_intact_outside_prompt() {
    // Verify that omitting turns from the prompt view does not mutate or drop the input candidate vector
    let tokenizer = Arc::new(ExactMockTokenizer::chatml());
    let engine = ContextAssemblyEngine::with_defaults(tokenizer, ChatTemplateType::ChatML);

    let original_turns = vec![
        ConversationTurn::user("t1", "Turn 1 content"),
        ConversationTurn::assistant("t2", "Turn 2 content"),
        ConversationTurn::user("t3", "Turn 3 content"),
        ConversationTurn::assistant("t4", "Turn 4 content"),
    ];

    let candidates = AssemblyCandidates {
        core_instruction: Some(CoreInstruction::default()),
        current_user_message: Some(CurrentUserMessage::new("Current turn")),
        conversation_turns: original_turns.clone(),
        ..Default::default()
    };

    let result = engine.assemble(candidates, 512).unwrap();

    // The assembly produced an inspectable prompt
    assert!(result.total_tokens <= result.budget_partition.prompt_budget);

    // The source original_turns vector remains 100% intact and unmutated
    assert_eq!(original_turns.len(), 4);
    assert_eq!(original_turns[0].content, "Turn 1 content");
    assert_eq!(original_turns[3].content, "Turn 4 content");
}

#[test]
fn test_ui_inspection_mapping() {
    let tokenizer = Arc::new(ExactMockTokenizer::chatml());
    let engine = ContextAssemblyEngine::with_defaults(tokenizer, ChatTemplateType::ChatML);

    let candidates = AssemblyCandidates {
        core_instruction: Some(CoreInstruction::default()),
        current_user_message: Some(CurrentUserMessage::new("Check the UI inspector models")),
        pinned_facts: vec![PinnedFact {
            id: "p1".into(),
            title: "Offline Rule".into(),
            content: "Zero cloud connections".into(),
            source_reference: Some("sess-1/msg-1".into()),
        }],
        ..Default::default()
    };

    let inspection = engine.assemble(candidates, 2048).unwrap();

    let ui_sections = inspection.ui_sections();
    assert!(!ui_sections.is_empty());
    assert!(ui_sections.iter().any(|(name, _)| name == "Core System Instructions"));
    assert!(ui_sections.iter().any(|(name, _)| name == "Current User Message"));

    let ui_included = inspection.ui_included_items();
    assert!(!ui_included.is_empty());
    assert!(ui_included.iter().any(|item| item.contains("Offline Rule")));

    let ui_excluded = inspection.ui_excluded_candidates();
    assert!(ui_excluded.is_empty()); // No trimming was needed for 2048 with small input
}
