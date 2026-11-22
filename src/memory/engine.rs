use rusqlite::params;
use crate::memory::error::MemoryError;
use crate::memory::fts::sanitize_fts5_query;
use crate::memory::models::{
    current_unix_timestamp, MemoryNote, MessageSearchResult, RetrievalOptions,
    ScoredMemoryNote,
};
use crate::memory::scoring::rank_and_sort_notes;
use crate::storage::{Database, MemoryNoteRecord, MessageRecord};

/// Local memory and retrieval engine leveraging SQLite FTS5 and composite ranking.
#[derive(Clone)]
pub struct MemoryEngine {
    db: Database,
}

impl MemoryEngine {
    /// Constructs a new MemoryEngine with the provided local Database instance.
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    /// Access to the underlying database.
    pub fn database(&self) -> &Database {
        &self.db
    }

    // --- NOTE CRUD & INSPECTION ---

    /// Inserts a new memory note into storage and the FTS5 index.
    pub fn create_note(&self, note: &MemoryNote) -> Result<MemoryNote, MemoryError> {
        let mut n = note.clone();
        if n.id.is_empty() {
            n.id = uuid::Uuid::new_v4().to_string();
        }
        let now = current_unix_timestamp();
        if n.created_at == 0 {
            n.created_at = now;
        }
        if n.updated_at == 0 {
            n.updated_at = now;
        }

        let record: MemoryNoteRecord = n.clone().into();
        self.db.create_memory_note(&record)?;
        Ok(n)
    }

    /// Fetches a memory note by its unique ID.
    pub fn get_note(&self, id: &str) -> Result<Option<MemoryNote>, MemoryError> {
        let rec = self.db.get_memory_note(id)?;
        Ok(rec.map(MemoryNote::from))
    }

    /// Updates content, title, and metadata of an existing note.
    pub fn update_note(&self, note: &MemoryNote) -> Result<(), MemoryError> {
        let mut n = note.clone();
        n.updated_at = current_unix_timestamp();
        let record: MemoryNoteRecord = n.into();
        self.db.update_memory_note(&record)?;
        Ok(())
    }

    /// Sets or unsets the pinned status of a note.
    pub fn set_pinned(&self, id: &str, is_pinned: bool) -> Result<(), MemoryError> {
        self.db.set_memory_note_pin(id, is_pinned)?;
        Ok(())
    }

    /// Enables or disables a note. Disabled notes are excluded from prompt retrieval.
    pub fn set_disabled(&self, id: &str, is_disabled: bool) -> Result<(), MemoryError> {
        self.db.set_memory_note_disabled(id, is_disabled)?;
        Ok(())
    }

    /// Permanently deletes a note from both the SQLite database table and the FTS5 virtual table index.
    pub fn hard_delete_note(&self, id: &str) -> Result<(), MemoryError> {
        self.db.delete_memory_note(id)?;

        // Verify FTS5 virtual index purge
        let conn_arc = self.db.raw_connection();
        let conn = conn_arc.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM memory_notes_fts WHERE id = ?1;",
            params![id],
            |r| r.get(0),
        )?;

        if count != 0 {
            // Manual cleanup fallback if triggers were somehow bypassed
            conn.execute("DELETE FROM memory_notes_fts WHERE id = ?1;", params![id])?;
        }

        Ok(())
    }

    /// Lists notes matching the given retrieval options and filters.
    pub fn list_notes(&self, options: &RetrievalOptions) -> Result<Vec<MemoryNote>, MemoryError> {
        let conn_arc = self.db.raw_connection();
        let conn = conn_arc.lock().unwrap();

        let mut sql = String::from(
            "SELECT id, session_id, title, content, source_message_id, source_message_ids,
                    is_pinned, is_summary, is_disabled, user_approved, created_at, updated_at
             FROM memory_notes WHERE 1=1",
        );

        let mut params_vec: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(ref sid) = options.session_id {
            sql.push_str(" AND (session_id = ? OR session_id IS NULL)");
            params_vec.push(sid.clone().into());
        }

        if !options.include_disabled {
            sql.push_str(" AND is_disabled = 0");
        }

        if options.require_approved {
            sql.push_str(" AND (is_summary = 0 OR user_approved = 1)");
        }

        if options.pinned_only {
            sql.push_str(" AND is_pinned = 1");
        }

        if options.summaries_only {
            sql.push_str(" AND is_summary = 1");
        }

        sql.push_str(" ORDER BY is_pinned DESC, updated_at DESC");

        if options.limit > 0 {
            sql.push_str(&format!(" LIMIT {}", options.limit));
        }

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params_vec), |r| {
            let pinned_int: i32 = r.get(6)?;
            let summary_int: i32 = r.get(7)?;
            let disabled_int: i32 = r.get(8)?;
            let approved_int: i32 = r.get(9)?;
            Ok(MemoryNoteRecord {
                id: r.get(0)?,
                session_id: r.get(1)?,
                title: r.get(2)?,
                content: r.get(3)?,
                source_message_id: r.get(4)?,
                source_message_ids: r.get(5)?,
                is_pinned: pinned_int != 0,
                is_summary: summary_int != 0,
                is_disabled: disabled_int != 0,
                user_approved: approved_int != 0,
                created_at: r.get(10)?,
                updated_at: r.get(11)?,
            })
        })?;

        let mut notes = Vec::new();
        for item in rows {
            notes.push(MemoryNote::from(item?));
        }
        Ok(notes)
    }

    // --- FTS5 RETRIEVAL & SCORING ---

    /// Retrieves notes scored and ranked by keyword relevance, session context, pin status, and recency.
    pub fn retrieve(&self, options: &RetrievalOptions) -> Result<Vec<ScoredMemoryNote>, MemoryError> {
        let now = current_unix_timestamp();

        if let Some(ref raw_query) = options.query {
            let trimmed = raw_query.trim();
            if !trimmed.is_empty() {
                if let Some(sanitized) = sanitize_fts5_query(trimmed) {
                    let candidates = self.query_notes_fts_with_bm25(&sanitized, options)?;
                    let ranked = rank_and_sort_notes(
                        candidates,
                        options.session_id.as_deref(),
                        &options.weights,
                        now,
                    );
                    return Ok(ranked.into_iter().take(options.limit).collect());
                }
            }
        }

        // Fallback or unqueried retrieval: list candidates and score by session, pin, recency
        let base_notes = self.list_notes(options)?;
        let candidates: Vec<(MemoryNote, Option<f64>)> =
            base_notes.into_iter().map(|n| (n, None)).collect();

        let ranked = rank_and_sort_notes(
            candidates,
            options.session_id.as_deref(),
            &options.weights,
            now,
        );

        Ok(ranked.into_iter().take(options.limit).collect())
    }

    fn query_notes_fts_with_bm25(
        &self,
        sanitized_query: &str,
        options: &RetrievalOptions,
    ) -> Result<Vec<(MemoryNote, Option<f64>)>, MemoryError> {
        let conn_arc = self.db.raw_connection();
        let conn = conn_arc.lock().unwrap();

        let mut sql = String::from(
            "SELECT m.id, m.session_id, m.title, m.content, m.source_message_id, m.source_message_ids,
                    m.is_pinned, m.is_summary, m.is_disabled, m.user_approved, m.created_at, m.updated_at,
                    bm25(memory_notes_fts) AS bm25_rank
             FROM memory_notes m
             JOIN memory_notes_fts fts ON m.id = fts.id
             WHERE memory_notes_fts MATCH ?1",
        );

        if !options.include_disabled {
            sql.push_str(" AND m.is_disabled = 0");
        }

        if options.require_approved {
            sql.push_str(" AND (m.is_summary = 0 OR m.user_approved = 1)");
        }

        if options.pinned_only {
            sql.push_str(" AND m.is_pinned = 1");
        }

        if options.summaries_only {
            sql.push_str(" AND m.is_summary = 1");
        }

        sql.push_str(" ORDER BY bm25(memory_notes_fts) ASC");

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![sanitized_query], |r| {
            let pinned_int: i32 = r.get(6)?;
            let summary_int: i32 = r.get(7)?;
            let disabled_int: i32 = r.get(8)?;
            let approved_int: i32 = r.get(9)?;
            let bm25_rank: f64 = r.get(12)?;

            let record = MemoryNoteRecord {
                id: r.get(0)?,
                session_id: r.get(1)?,
                title: r.get(2)?,
                content: r.get(3)?,
                source_message_id: r.get(4)?,
                source_message_ids: r.get(5)?,
                is_pinned: pinned_int != 0,
                is_summary: summary_int != 0,
                is_disabled: disabled_int != 0,
                user_approved: approved_int != 0,
                created_at: r.get(10)?,
                updated_at: r.get(11)?,
            };
            Ok((MemoryNote::from(record), Some(bm25_rank)))
        })?;

        let mut results = Vec::new();
        for item in rows {
            results.push(item?);
        }
        Ok(results)
    }

    // --- MESSAGE FTS SEARCH ---

    /// Searches conversation messages using SQLite FTS5.
    pub fn search_messages(
        &self,
        query: &str,
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MessageSearchResult>, MemoryError> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        let sanitized = match sanitize_fts5_query(trimmed) {
            Some(s) => s,
            None => return Ok(Vec::new()),
        };

        let conn_arc = self.db.raw_connection();
        let conn = conn_arc.lock().unwrap();

        let sql = match session_id {
            Some(_) => "
                SELECT m.id, m.session_id, m.role, m.content, m.token_count, m.created_at, m.is_pinned,
                       bm25(messages_fts) AS bm25_rank
                FROM messages m
                JOIN messages_fts fts ON m.id = fts.id
                WHERE messages_fts MATCH ?1
                  AND m.session_id = ?2
                ORDER BY bm25(messages_fts) ASC, m.created_at DESC
                LIMIT ?3;",
            None => "
                SELECT m.id, m.session_id, m.role, m.content, m.token_count, m.created_at, m.is_pinned,
                       bm25(messages_fts) AS bm25_rank
                FROM messages m
                JOIN messages_fts fts ON m.id = fts.id
                WHERE messages_fts MATCH ?1
                ORDER BY bm25(messages_fts) ASC, m.created_at DESC
                LIMIT ?2;",
        };

        let mut stmt = conn.prepare(sql)?;
        let limit_i64 = limit as i64;
        let mut results = Vec::new();

        if let Some(sid) = session_id {
            let rows = stmt.query_map(params![sanitized, sid, limit_i64], |r| {
                let tc: Option<i64> = r.get(4)?;
                let pinned_int: i32 = r.get(6)?;
                Ok(MessageSearchResult {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    token_count: tc.map(|c| c as usize),
                    created_at: r.get(5)?,
                    is_pinned: pinned_int != 0,
                    rank: 0,
                })
            })?;
            for (idx, item) in rows.enumerate() {
                let mut res = item?;
                res.rank = idx + 1;
                results.push(res);
            }
        } else {
            let rows = stmt.query_map(params![sanitized, limit_i64], |r| {
                let tc: Option<i64> = r.get(4)?;
                let pinned_int: i32 = r.get(6)?;
                Ok(MessageSearchResult {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    token_count: tc.map(|c| c as usize),
                    created_at: r.get(5)?,
                    is_pinned: pinned_int != 0,
                    rank: 0,
                })
            })?;
            for (idx, item) in rows.enumerate() {
                let mut res = item?;
                res.rank = idx + 1;
                results.push(res);
            }
        }

        Ok(results)
    }

    /// Hard deletes a message from both the messages table and messages_fts index.
    pub fn hard_delete_message(&self, message_id: &str) -> Result<(), MemoryError> {
        self.db.delete_message(message_id)?;

        let conn_arc = self.db.raw_connection();
        let conn = conn_arc.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM messages_fts WHERE id = ?1;",
            params![message_id],
            |r| r.get(0),
        )?;

        if count != 0 {
            conn.execute("DELETE FROM messages_fts WHERE id = ?1;", params![message_id])?;
        }

        Ok(())
    }

    // --- SOURCE LINKAGE & SUMMARIES ---

    /// Resolves the actual conversation MessageRecords linked to a memory note.
    pub fn get_source_messages_for_note(
        &self,
        note: &MemoryNote,
    ) -> Result<Vec<MessageRecord>, MemoryError> {
        let mut messages = Vec::new();
        for msg_id in &note.source_message_ids {
            if let Some(msg) = self.db.get_message(msg_id)? {
                messages.push(msg);
            }
        }
        Ok(messages)
    }

    /// Formats an informative source reference string for a memory note.
    pub fn format_source_reference(&self, note: &MemoryNote) -> Result<String, MemoryError> {
        if note.source_message_ids.is_empty() {
            return Ok("User explicit memory".to_string());
        }

        let sources = self.get_source_messages_for_note(note)?;
        if sources.is_empty() {
            return Ok(format!("Linked to {} messages", note.source_message_ids.len()));
        }

        let roles: Vec<&str> = sources.iter().map(|m| m.role.as_str()).collect();
        let first_id = &sources[0].id;
        Ok(format!(
            "Derived from {} message(s) [{}...], roles: {:?}",
            sources.len(),
            &first_id[..first_id.len().min(8)],
            roles
        ))
    }

    /// Creates an extracted summary proposal.
    /// Event-driven summaries start as unapproved until explicit user approval.
    pub fn create_extracted_summary(
        &self,
        session_id: Option<&str>,
        title: &str,
        summary: &str,
        source_message_ids: Vec<String>,
        auto_approve: bool,
    ) -> Result<MemoryNote, MemoryError> {
        let note = MemoryNote::new_extracted_summary(
            title,
            summary,
            session_id.map(|s| s.to_string()),
            source_message_ids,
            auto_approve,
        );
        self.create_note(&note)
    }

    /// Approves an extracted summary, allowing it into active prompt retrieval context.
    pub fn approve_summary(&self, note_id: &str) -> Result<(), MemoryError> {
        let mut note = self
            .get_note(note_id)?
            .ok_or_else(|| MemoryError::NotFound(note_id.to_string()))?;

        note.user_approved = true;
        self.update_note(&note)
    }
}
