use super::*;
use crate::storage::{Database, MessageRecord, SessionRecord};
use std::time::{SystemTime, UNIX_EPOCH};

fn setup_test_engine() -> (MemoryEngine, Database) {
    let db = Database::open_in_memory().expect("Failed to create in-memory database");
    let engine = MemoryEngine::new(db.clone());
    (engine, db)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

#[test]
fn test_notes_fts5_indexing_and_search() {
    let (engine, _) = setup_test_engine();

    let note1 = MemoryNote::new_manual(
        "Memory Safety In Rust",
        "The borrow checker enforces ownership and lifetime rules at compile time.",
        Some("session-1".to_string()),
        false,
    );
    let note2 = MemoryNote::new_manual(
        "SQLite Full Text Search",
        "FTS5 provides BM25 scoring for fast local text retrieval without an external vector DB.",
        Some("session-1".to_string()),
        false,
    );

    let created1 = engine.create_note(&note1).unwrap();
    let created2 = engine.create_note(&note2).unwrap();

    // Search for "borrow"
    let options = RetrievalOptions::for_prompt(Some("session-1"), Some("borrow"), 10);
    let results = engine.retrieve(&options).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].note.id, created1.id);
    assert!(results[0].keyword_score > 0.0);

    // Search for "FTS5 vector"
    let options_sql = RetrievalOptions::for_prompt(Some("session-1"), Some("FTS5 vector"), 10);
    let results_sql = engine.retrieve(&options_sql).unwrap();
    assert_eq!(results_sql.len(), 1);
    assert_eq!(results_sql[0].note.id, created2.id);
}

#[test]
fn test_messages_fts5_indexing_and_search() {
    let (engine, db) = setup_test_engine();

    let session = SessionRecord {
        id: "sess-100".to_string(),
        title: "Systems Engineering Session".to_string(),
        created_at: 100,
        updated_at: 100,
        pinned_facts: None,
        task_state: None,
    };
    db.create_session(&session).unwrap();

    let msg1 = MessageRecord {
        id: "msg-1".to_string(),
        session_id: "sess-100".to_string(),
        role: "user".to_string(),
        content: "What is zero-cost abstraction in modern systems languages?".to_string(),
        token_count: Some(10),
        created_at: 101,
        is_pinned: false,
        metadata: None,
    };
    let msg2 = MessageRecord {
        id: "msg-2".to_string(),
        session_id: "sess-100".to_string(),
        role: "assistant".to_string(),
        content: "Zero-cost abstractions ensure what you don't use, you don't pay for in runtime overhead.".to_string(),
        token_count: Some(18),
        created_at: 102,
        is_pinned: true,
        metadata: None,
    };

    db.create_message(&msg1).unwrap();
    db.create_message(&msg2).unwrap();

    // FTS search across messages
    let search_res = engine.search_messages("overhead runtime", Some("sess-100"), 10).unwrap();
    assert_eq!(search_res.len(), 1);
    assert_eq!(search_res[0].id, "msg-2");

    // Global message search without session scoping
    let global_res = engine.search_messages("abstraction", None, 10).unwrap();
    assert_eq!(global_res.len(), 2);
}

#[test]
fn test_note_crud_and_inspection() {
    let (engine, _) = setup_test_engine();

    let mut note = MemoryNote::new_manual(
        "Initial Title",
        "Original memory excerpt.",
        Some("session-crud".to_string()),
        false,
    );
    note = engine.create_note(&note).unwrap();

    // Inspect
    let fetched = engine.get_note(&note.id).unwrap().expect("Note should exist");
    assert_eq!(fetched.title, "Initial Title");
    assert_eq!(fetched.content, "Original memory excerpt.");

    // Edit
    let mut updated = fetched;
    updated.title = "Refined Title".to_string();
    updated.content = "Updated memory content with new insights.".to_string();
    engine.update_note(&updated).unwrap();

    // Verify inspection
    let inspected = engine.get_note(&note.id).unwrap().expect("Note should exist");
    assert_eq!(inspected.title, "Refined Title");
    assert_eq!(inspected.content, "Updated memory content with new insights.");
    assert!(inspected.updated_at >= note.updated_at);

    // Verify FTS updated
    let search = engine.retrieve(&RetrievalOptions::for_prompt(None, Some("insights"), 5)).unwrap();
    assert_eq!(search.len(), 1);
    assert_eq!(search[0].note.id, note.id);
}

#[test]
fn test_pin_and_disable_behavior() {
    let (engine, _) = setup_test_engine();

    let note = engine.create_note(&MemoryNote::new_manual(
        "Security Rule",
        "Offline boundary invariant: no network sockets.",
        Some("session-sec".to_string()),
        false,
    )).unwrap();

    // Initially unpinned
    assert!(!engine.get_note(&note.id).unwrap().unwrap().is_pinned);

    // Pin note
    engine.set_pinned(&note.id, true).unwrap();
    assert!(engine.get_note(&note.id).unwrap().unwrap().is_pinned);

    // Disable note
    engine.set_disabled(&note.id, true).unwrap();
    assert!(engine.get_note(&note.id).unwrap().unwrap().is_disabled);

    // Prompt retrieval should exclude disabled note by default
    let retrieved = engine.retrieve(&RetrievalOptions::for_prompt(Some("session-sec"), Some("boundary"), 10)).unwrap();
    assert!(retrieved.is_empty());

    // When include_disabled is explicitly true (e.g. for Memory Management UI), it is visible
    let mut admin_opts = RetrievalOptions::for_prompt(Some("session-sec"), Some("boundary"), 10);
    admin_opts.include_disabled = true;
    let admin_res = engine.retrieve(&admin_opts).unwrap();
    assert_eq!(admin_res.len(), 1);

    // Re-enable note
    engine.set_disabled(&note.id, false).unwrap();
    let re_enabled = engine.retrieve(&RetrievalOptions::for_prompt(Some("session-sec"), Some("boundary"), 10)).unwrap();
    assert_eq!(re_enabled.len(), 1);
}

#[test]
fn test_hard_delete_purges_db_and_fts_index() {
    let (engine, _) = setup_test_engine();

    let note = engine.create_note(&MemoryNote::new_manual(
        "Confidential Fact",
        "UniqueSecretKeyword to be completely erased.",
        Some("sess-del".to_string()),
        false,
    )).unwrap();

    let res_before = engine.retrieve(&RetrievalOptions::for_prompt(None, Some("UniqueSecretKeyword"), 5)).unwrap();
    assert_eq!(res_before.len(), 1);

    // Hard delete
    engine.hard_delete_note(&note.id).unwrap();

    // Verify row gone from main table
    assert!(engine.get_note(&note.id).unwrap().is_none());

    // Verify search finds nothing in FTS5
    let res_after = engine.retrieve(&RetrievalOptions::for_prompt(None, Some("UniqueSecretKeyword"), 5)).unwrap();
    assert!(res_after.is_empty());
}

#[test]
fn test_hard_delete_message_purges_db_and_fts_index() {
    let (engine, db) = setup_test_engine();

    let session = SessionRecord {
        id: "sess-msg-del".to_string(),
        title: "Deletion Test".to_string(),
        created_at: 10,
        updated_at: 10,
        pinned_facts: None,
        task_state: None,
    };
    db.create_session(&session).unwrap();

    let msg = MessageRecord {
        id: "msg-to-delete".to_string(),
        session_id: "sess-msg-del".to_string(),
        role: "user".to_string(),
        content: "EphemeralDataMarker to delete".to_string(),
        token_count: Some(5),
        created_at: 11,
        is_pinned: false,
        metadata: None,
    };
    db.create_message(&msg).unwrap();

    // Confirm message is in FTS
    let before = engine.search_messages("EphemeralDataMarker", None, 5).unwrap();
    assert_eq!(before.len(), 1);

    // Hard delete message
    engine.hard_delete_message(&msg.id).unwrap();

    // Confirm DB row is gone
    assert!(db.get_message(&msg.id).unwrap().is_none());

    // Confirm search finds nothing in FTS5
    let after = engine.search_messages("EphemeralDataMarker", None, 5).unwrap();
    assert!(after.is_empty());
}

#[test]
fn test_source_message_linking() {
    let (engine, db) = setup_test_engine();

    let session = SessionRecord {
        id: "sess-link".to_string(),
        title: "Linkage Session".to_string(),
        created_at: 200,
        updated_at: 200,
        pinned_facts: None,
        task_state: None,
    };
    db.create_session(&session).unwrap();

    let msg1 = MessageRecord {
        id: "src-msg-1".to_string(),
        session_id: "sess-link".to_string(),
        role: "user".to_string(),
        content: "We decided to target a 20% output reserve.".to_string(),
        token_count: Some(10),
        created_at: 201,
        is_pinned: false,
        metadata: None,
    };
    let msg2 = MessageRecord {
        id: "src-msg-2".to_string(),
        session_id: "sess-link".to_string(),
        role: "assistant".to_string(),
        content: "Acknowledged. Safety margin set to 5%.".to_string(),
        token_count: Some(9),
        created_at: 202,
        is_pinned: false,
        metadata: None,
    };

    db.create_message(&msg1).unwrap();
    db.create_message(&msg2).unwrap();

    let summary = engine.create_extracted_summary(
        Some("sess-link"),
        "Budget Configuration Decision",
        "Agreed on 20% output reserve and 5% safety margin.",
        vec!["src-msg-1".to_string(), "src-msg-2".to_string()],
        true,
    ).unwrap();

    assert_eq!(summary.source_message_ids.len(), 2);
    assert_eq!(summary.note_type, NoteType::ExtractedSummary);

    // Resolve source messages
    let linked_messages = engine.get_source_messages_for_note(&summary).unwrap();
    assert_eq!(linked_messages.len(), 2);
    assert_eq!(linked_messages[0].id, "src-msg-1");
    assert_eq!(linked_messages[1].id, "src-msg-2");

    // Format reference string
    let ref_str = engine.format_source_reference(&summary).unwrap();
    assert!(ref_str.contains("Derived from 2 message(s)"));
}

#[test]
fn test_summary_approval_workflow() {
    let (engine, _) = setup_test_engine();

    // Create proposed summary with auto_approve = false
    let unapproved = engine.create_extracted_summary(
        Some("session-wf"),
        "Proposed Summary",
        "Candidate summary awaiting user approval.",
        vec!["msg-x".to_string()],
        false,
    ).unwrap();

    assert!(!unapproved.user_approved);
    assert!(!unapproved.can_include_in_prompt());

    // Prompt retrieval with require_approved = true (default) must exclude it
    let opts = RetrievalOptions::for_prompt(Some("session-wf"), Some("Candidate"), 10);
    let results = engine.retrieve(&opts).unwrap();
    assert!(results.is_empty());

    // User explicitly approves summary
    engine.approve_summary(&unapproved.id).unwrap();

    let approved = engine.get_note(&unapproved.id).unwrap().unwrap();
    assert!(approved.user_approved);
    assert!(approved.can_include_in_prompt());

    // Now prompt retrieval includes it
    let results_after = engine.retrieve(&opts).unwrap();
    assert_eq!(results_after.len(), 1);
    assert_eq!(results_after[0].note.id, unapproved.id);
}

#[test]
fn test_scoring_weights_and_recency_decay() {
    let (engine, _) = setup_test_engine();
    let now = now_secs();

    // Create 3 notes:
    // 1. Pinned note in current session
    // 2. Fresh unpinned note in current session
    // 3. Old note in another session with matching keyword
    let mut note_pinned = MemoryNote::new_manual(
        "Important Rule",
        "Deterministic context assembly algorithm.",
        Some("session-target".to_string()),
        true,
    );
    note_pinned.updated_at = now;

    let mut note_fresh = MemoryNote::new_manual(
        "Fresh Turn Note",
        "Deterministic context assembly details.",
        Some("session-target".to_string()),
        false,
    );
    note_fresh.updated_at = now;

    let mut note_old = MemoryNote::new_manual(
        "Old Session Note",
        "Deterministic context assembly archive.",
        Some("session-other".to_string()),
        false,
    );
    note_old.updated_at = now - (30 * 86400); // 30 days old

    engine.create_note(&note_pinned).unwrap();
    engine.create_note(&note_fresh).unwrap();
    engine.create_note(&note_old).unwrap();

    let opts = RetrievalOptions::for_prompt(Some("session-target"), Some("Deterministic"), 10);
    let results = engine.retrieve(&opts).unwrap();

    assert_eq!(results.len(), 3);
    // Pinned note must rank first
    assert_eq!(results[0].note.title, "Important Rule");
    assert!(results[0].is_pinned);
    assert!(results[0].pin_score > 0.0);

    // Fresh current-session note must beat old other-session note
    assert_eq!(results[1].note.title, "Fresh Turn Note");
    assert_eq!(results[2].note.title, "Old Session Note");
    assert!(results[1].final_score > results[2].final_score);
    assert!(results[1].recency_score > results[2].recency_score);
}

#[test]
fn test_safe_fts5_syntax_resilience() {
    let (engine, _) = setup_test_engine();

    engine.create_note(&MemoryNote::new_manual(
        "Symbols and Code",
        "Syntax highlighting fn foo() -> Result<(), Error> &mut [u8]",
        Some("session-sym".to_string()),
        false,
    )).unwrap();

    // Query with messy symbols that would break un-sanitized SQLite FTS5 queries
    let dirty_queries = [
        ":::***\"\"\"(((AND OR NOT)))",
        "fn foo() -> Result",
        "\"unclosed quote",
        "AND",
        "OR NOT NEAR",
        "{+~?!;^}",
    ];

    for q in dirty_queries {
        let opts = RetrievalOptions::for_prompt(Some("session-sym"), Some(q), 5);
        let res = engine.retrieve(&opts);
        assert!(res.is_ok(), "Query '{}' should not fail or panic", q);
    }
}
