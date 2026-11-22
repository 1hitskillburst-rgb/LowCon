use std::path::Path;
use std::sync::{Arc, Mutex};
use rusqlite::{params, Connection, OptionalExtension};

use crate::config::ModelProfile;
use crate::privacy::StorageLocationPolicy;
use crate::storage::error::StorageError;
use crate::storage::models::{MemoryNoteRecord, MessageRecord, SessionRecord};
use crate::storage::schema::apply_migrations;

/// Thread-safe SQLite database handle wrapping connections with WAL mode and foreign key support.
#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    /// Opens an in-memory database instance (ideal for tests and temporary sessions).
    pub fn open_in_memory() -> Result<Self, StorageError> {
        let mut conn = Connection::open_in_memory()?;
        Self::configure_connection(&mut conn)?;
        apply_migrations(&mut conn).map_err(|e| StorageError::Migration(e.to_string()))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Opens a database file after verifying it strictly satisfies the storage location policy.
    pub fn open<P: AsRef<Path>>(path: P, policy: &StorageLocationPolicy) -> Result<Self, StorageError> {
        let validated = policy.validate_path(path.as_ref())?;
        if let Some(parent) = validated.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut conn = Connection::open(&validated)?;
        Self::configure_connection(&mut conn)?;
        apply_migrations(&mut conn).map_err(|e| StorageError::Migration(e.to_string()))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn configure_connection(conn: &mut Connection) -> Result<(), StorageError> {
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        let _ = conn.pragma_update(None, "busy_timeout", 5000);
        Ok(())
    }

    /// Provides access to the underlying thread-safe SQLite connection handle.
    pub fn raw_connection(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.conn)
    }

    // --- SESSIONS ---

    pub fn create_session(&self, s: &SessionRecord) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at, pinned_facts, task_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6);",
            params![s.id, s.title, s.created_at, s.updated_at, s.pinned_facts, s.task_state],
        )?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> Result<Option<SessionRecord>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, updated_at, pinned_facts, task_state
             FROM sessions WHERE id = ?1;"
        )?;
        let row = stmt.query_row(params![id], |r| {
            Ok(SessionRecord {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
                pinned_facts: r.get(4)?,
                task_state: r.get(5)?,
            })
        }).optional()?;
        Ok(row)
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionRecord>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, title, created_at, updated_at, pinned_facts, task_state
             FROM sessions ORDER BY updated_at DESC;"
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SessionRecord {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
                pinned_facts: r.get(4)?,
                task_state: r.get(5)?,
            })
        })?;

        let mut list = Vec::new();
        for s in rows {
            list.push(s?);
        }
        Ok(list)
    }

    pub fn update_session(&self, s: &SessionRecord) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE sessions
             SET title = ?2, updated_at = ?3, pinned_facts = ?4, task_state = ?5
             WHERE id = ?1;",
            params![s.id, s.title, s.updated_at, s.pinned_facts, s.task_state],
        )?;
        Ok(())
    }

    pub fn delete_session(&self, id: &str) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sessions WHERE id = ?1;", params![id])?;
        Ok(())
    }

    // --- MESSAGES ---

    pub fn create_message(&self, m: &MessageRecord) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, token_count, created_at, is_pinned, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);",
            params![
                m.id,
                m.session_id,
                m.role,
                m.content,
                m.token_count.map(|c| c as i64),
                m.created_at,
                m.is_pinned as i32,
                m.metadata
            ],
        )?;
        Ok(())
    }

    pub fn list_messages_by_session(&self, session_id: &str) -> Result<Vec<MessageRecord>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, token_count, created_at, is_pinned, metadata
             FROM messages WHERE session_id = ?1 ORDER BY created_at ASC;"
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            let tc: Option<i64> = r.get(4)?;
            let pinned_int: i32 = r.get(6)?;
            Ok(MessageRecord {
                id: r.get(0)?,
                session_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                token_count: tc.map(|c| c as usize),
                created_at: r.get(5)?,
                is_pinned: pinned_int != 0,
                metadata: r.get(7)?,
            })
        })?;

        let mut msgs = Vec::new();
        for m in rows {
            msgs.push(m?);
        }
        Ok(msgs)
    }

    pub fn get_message(&self, id: &str) -> Result<Option<MessageRecord>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, token_count, created_at, is_pinned, metadata
             FROM messages WHERE id = ?1;"
        )?;
        let row = stmt.query_row(params![id], |r| {
            let tc: Option<i64> = r.get(4)?;
            let pinned_int: i32 = r.get(6)?;
            Ok(MessageRecord {
                id: r.get(0)?,
                session_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                token_count: tc.map(|c| c as usize),
                created_at: r.get(5)?,
                is_pinned: pinned_int != 0,
                metadata: r.get(7)?,
            })
        }).optional()?;
        Ok(row)
    }

    pub fn set_message_pin(&self, id: &str, is_pinned: bool) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET is_pinned = ?2 WHERE id = ?1;",
            params![id, is_pinned as i32],
        )?;
        Ok(())
    }

    pub fn delete_message(&self, id: &str) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM messages WHERE id = ?1;", params![id])?;
        Ok(())
    }

    // --- MEMORY NOTES & FTS5 RETRIEVAL ---

    pub fn create_memory_note(&self, n: &MemoryNoteRecord) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO memory_notes (id, session_id, title, content, source_message_id, source_message_ids, is_pinned, is_summary, is_disabled, user_approved, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);",
            params![
                n.id,
                n.session_id,
                n.title,
                n.content,
                n.source_message_id,
                n.source_message_ids,
                n.is_pinned as i32,
                n.is_summary as i32,
                n.is_disabled as i32,
                n.user_approved as i32,
                n.created_at,
                n.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn get_memory_note(&self, id: &str) -> Result<Option<MemoryNoteRecord>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, title, content, source_message_id, source_message_ids, is_pinned, is_summary, is_disabled, user_approved, created_at, updated_at
             FROM memory_notes WHERE id = ?1;"
        )?;
        let row = stmt.query_row(params![id], |r| {
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
        }).optional()?;
        Ok(row)
    }

    pub fn list_memory_notes(&self, session_id: Option<&str>) -> Result<Vec<MemoryNoteRecord>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut list = Vec::new();

        if let Some(sid) = session_id {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, title, content, source_message_id, source_message_ids, is_pinned, is_summary, is_disabled, user_approved, created_at, updated_at
                 FROM memory_notes WHERE session_id = ?1 OR session_id IS NULL
                 ORDER BY is_pinned DESC, updated_at DESC;"
            )?;
            let rows = stmt.query_map(params![sid], |r| {
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
            for item in rows {
                list.push(item?);
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, session_id, title, content, source_message_id, source_message_ids, is_pinned, is_summary, is_disabled, user_approved, created_at, updated_at
                 FROM memory_notes
                 ORDER BY is_pinned DESC, updated_at DESC;"
            )?;
            let rows = stmt.query_map([], |r| {
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
            for item in rows {
                list.push(item?);
            }
        }

        Ok(list)
    }

    /// Full-text search with ranking across memory notes using SQLite FTS5.
    pub fn search_memory_notes_fts(
        &self,
        query: &str,
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MemoryNoteRecord>, StorageError> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            // Return top notes without FTS filter
            let all = self.list_memory_notes(session_id)?;
            return Ok(all.into_iter().take(limit).collect());
        }

        // Sanitize FTS5 query to prevent syntax errors on raw symbols
        let sanitized_query = sanitize_fts5_query(trimmed);
        if sanitized_query.is_empty() {
            let all = self.list_memory_notes(session_id)?;
            return Ok(all.into_iter().take(limit).collect());
        }

        let conn = self.conn.lock().unwrap();
        let sql = match session_id {
            Some(_) => "
                SELECT m.id, m.session_id, m.title, m.content, m.source_message_id, m.source_message_ids,
                       m.is_pinned, m.is_summary, m.is_disabled, m.user_approved, m.created_at, m.updated_at
                FROM memory_notes m
                JOIN memory_notes_fts fts ON m.id = fts.id
                WHERE memory_notes_fts MATCH ?1
                  AND (m.session_id = ?2 OR m.session_id IS NULL)
                ORDER BY m.is_pinned DESC, bm25(memory_notes_fts) ASC, m.updated_at DESC
                LIMIT ?3;",
            None => "
                SELECT m.id, m.session_id, m.title, m.content, m.source_message_id, m.source_message_ids,
                       m.is_pinned, m.is_summary, m.is_disabled, m.user_approved, m.created_at, m.updated_at
                FROM memory_notes m
                JOIN memory_notes_fts fts ON m.id = fts.id
                WHERE memory_notes_fts MATCH ?1
                ORDER BY m.is_pinned DESC, bm25(memory_notes_fts) ASC, m.updated_at DESC
                LIMIT ?2;",
        };

        let mut stmt = conn.prepare(sql)?;
        let limit_i64 = limit as i64;
        let mut notes = Vec::new();

        if let Some(sid) = session_id {
            let rows = stmt.query_map(params![sanitized_query, sid, limit_i64], |r| {
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
            for item in rows {
                notes.push(item?);
            }
        } else {
            let rows = stmt.query_map(params![sanitized_query, limit_i64], |r| {
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
            for item in rows {
                notes.push(item?);
            }
        }

        Ok(notes)
    }

    pub fn update_memory_note(&self, n: &MemoryNoteRecord) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE memory_notes
             SET title = ?2, content = ?3, source_message_id = ?4, source_message_ids = ?5,
                 is_pinned = ?6, is_summary = ?7, is_disabled = ?8, user_approved = ?9, updated_at = ?10
             WHERE id = ?1;",
            params![
                n.id,
                n.title,
                n.content,
                n.source_message_id,
                n.source_message_ids,
                n.is_pinned as i32,
                n.is_summary as i32,
                n.is_disabled as i32,
                n.user_approved as i32,
                n.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn set_memory_note_pin(&self, id: &str, is_pinned: bool) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE memory_notes SET is_pinned = ?2 WHERE id = ?1;",
            params![id, is_pinned as i32],
        )?;
        Ok(())
    }

    pub fn set_memory_note_disabled(&self, id: &str, is_disabled: bool) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE memory_notes SET is_disabled = ?2 WHERE id = ?1;",
            params![id, is_disabled as i32],
        )?;
        Ok(())
    }

    pub fn delete_memory_note(&self, id: &str) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM memory_notes WHERE id = ?1;", params![id])?;
        Ok(())
    }

    /// Full-text search with ranking across stored messages using SQLite FTS5.
    pub fn search_messages_fts(
        &self,
        query: &str,
        session_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<MessageRecord>, StorageError> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        let sanitized_query = sanitize_fts5_query(trimmed);
        if sanitized_query.is_empty() {
            return Ok(Vec::new());
        }

        let conn = self.conn.lock().unwrap();
        let sql = match session_id {
            Some(_) => "
                SELECT m.id, m.session_id, m.role, m.content, m.token_count, m.created_at, m.is_pinned, m.metadata
                FROM messages m
                JOIN messages_fts fts ON m.id = fts.id
                WHERE messages_fts MATCH ?1
                  AND m.session_id = ?2
                ORDER BY bm25(messages_fts) ASC, m.created_at DESC
                LIMIT ?3;",
            None => "
                SELECT m.id, m.session_id, m.role, m.content, m.token_count, m.created_at, m.is_pinned, m.metadata
                FROM messages m
                JOIN messages_fts fts ON m.id = fts.id
                WHERE messages_fts MATCH ?1
                ORDER BY bm25(messages_fts) ASC, m.created_at DESC
                LIMIT ?2;",
        };

        let mut stmt = conn.prepare(sql)?;
        let limit_i64 = limit as i64;
        let mut messages = Vec::new();

        if let Some(sid) = session_id {
            let rows = stmt.query_map(params![sanitized_query, sid, limit_i64], |r| {
                let tc: Option<i64> = r.get(4)?;
                let pinned_int: i32 = r.get(6)?;
                Ok(MessageRecord {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    token_count: tc.map(|c| c as usize),
                    created_at: r.get(5)?,
                    is_pinned: pinned_int != 0,
                    metadata: r.get(7)?,
                })
            })?;
            for item in rows {
                messages.push(item?);
            }
        } else {
            let rows = stmt.query_map(params![sanitized_query, limit_i64], |r| {
                let tc: Option<i64> = r.get(4)?;
                let pinned_int: i32 = r.get(6)?;
                Ok(MessageRecord {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    role: r.get(2)?,
                    content: r.get(3)?,
                    token_count: tc.map(|c| c as usize),
                    created_at: r.get(5)?,
                    is_pinned: pinned_int != 0,
                    metadata: r.get(7)?,
                })
            })?;
            for item in rows {
                messages.push(item?);
            }
        }

        Ok(messages)
    }

    // --- MODEL PROFILES ---

    pub fn save_model_profile(&self, p: &ModelProfile) -> Result<(), StorageError> {
        let json_settings = serde_json::to_string(p)?;
        let template_str = serde_json::to_string(&p.chat_template)?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO model_profiles (id, name, file_path, context_capacity, context_override, chat_template, settings_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                file_path = excluded.file_path,
                context_capacity = excluded.context_capacity,
                context_override = excluded.context_override,
                chat_template = excluded.chat_template,
                settings_json = excluded.settings_json;",
            params![
                p.id,
                p.name,
                p.file_path.to_string_lossy().to_string(),
                p.context_capacity as i64,
                p.context_override.map(|o| o as i64),
                template_str,
                json_settings,
                p.created_at
            ],
        )?;
        Ok(())
    }

    pub fn get_model_profile(&self, id: &str) -> Result<Option<ModelProfile>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT settings_json FROM model_profiles WHERE id = ?1;"
        )?;
        let json_opt: Option<String> = stmt.query_row(params![id], |r| r.get(0)).optional()?;
        if let Some(json_str) = json_opt {
            let profile: ModelProfile = serde_json::from_str(&json_str)?;
            Ok(Some(profile))
        } else {
            Ok(None)
        }
    }

    pub fn list_model_profiles(&self) -> Result<Vec<ModelProfile>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT settings_json FROM model_profiles ORDER BY created_at ASC;"
        )?;
        let rows = stmt.query_map([], |r| {
            let json_str: String = r.get(0)?;
            Ok(json_str)
        })?;

        let mut list = Vec::new();
        for json_res in rows {
            let json_str = json_res?;
            if let Ok(profile) = serde_json::from_str::<ModelProfile>(&json_str) {
                list.push(profile);
            }
        }
        Ok(list)
    }

    pub fn delete_model_profile(&self, id: &str) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM model_profiles WHERE id = ?1;", params![id])?;
        Ok(())
    }

    // --- VAULT METADATA ---

    pub fn set_vault_metadata(&self, key: &str, value: &[u8]) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO vault_metadata (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_vault_metadata(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM vault_metadata WHERE key = ?1;")?;
        let res: Option<Vec<u8>> = stmt.query_row(params![key], |r| r.get(0)).optional()?;
        Ok(res)
    }
}

/// Escapes words for safe SQLite FTS5 queries (tokenizes into quoted strings).
fn sanitize_fts5_query(input: &str) -> String {
    let words: Vec<String> = input
        .split(|c: char| c.is_whitespace() || c == '"' || c == '*' || c == ':' || c == '(' || c == ')' || c == '^')
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"", w))
        .collect();
    words.join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_in_memory_db_migrations() {
        let db = Database::open_in_memory().expect("Failed to open in-memory database");
        let sessions = db.list_sessions().expect("Failed to list sessions");
        assert!(sessions.is_empty());
    }

    #[test]
    fn test_sessions_and_messages_lifecycle() {
        let db = Database::open_in_memory().unwrap();

        let session = SessionRecord {
            id: "session-1".to_string(),
            title: "First Local Chat".to_string(),
            created_at: 1000,
            updated_at: 1000,
            pinned_facts: Some("Target context limit: 2048".to_string()),
            task_state: Some("Goal: Build LowCon".to_string()),
        };
        db.create_session(&session).unwrap();

        let retrieved = db.get_session("session-1").unwrap().expect("Session not found");
        assert_eq!(retrieved.title, "First Local Chat");
        assert_eq!(retrieved.task_state.as_deref(), Some("Goal: Build LowCon"));

        // Add messages
        let msg1 = MessageRecord {
            id: "msg-1".to_string(),
            session_id: "session-1".to_string(),
            role: "user".to_string(),
            content: "Hello local assistant".to_string(),
            token_count: Some(5),
            created_at: 1001,
            is_pinned: false,
            metadata: None,
        };
        let msg2 = MessageRecord {
            id: "msg-2".to_string(),
            session_id: "session-1".to_string(),
            role: "assistant".to_string(),
            content: "Hello! I am running fully offline.".to_string(),
            token_count: Some(8),
            created_at: 1002,
            is_pinned: true,
            metadata: None,
        };

        db.create_message(&msg1).unwrap();
        db.create_message(&msg2).unwrap();

        let msgs = db.list_messages_by_session("session-1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content, "Hello local assistant");
        assert!(msgs[1].is_pinned);

        // Delete session cascades to messages
        db.delete_session("session-1").unwrap();
        assert!(db.get_session("session-1").unwrap().is_none());
        assert!(db.list_messages_by_session("session-1").unwrap().is_empty());
    }

    #[test]
    fn test_memory_notes_fts5_search() {
        let db = Database::open_in_memory().unwrap();

        let note1 = MemoryNoteRecord {
            id: "note-1".to_string(),
            session_id: Some("session-a".to_string()),
            title: Some("Rust Memory Safety".to_string()),
            content: "Ownership and borrow checker guarantee memory safety without garbage collection.".to_string(),
            source_message_id: None,
            source_message_ids: None,
            is_pinned: true,
            is_summary: false,
            is_disabled: false,
            user_approved: true,
            created_at: 2000,
            updated_at: 2000,
        };

        let note2 = MemoryNoteRecord {
            id: "note-2".to_string(),
            session_id: Some("session-a".to_string()),
            title: Some("SQLite FTS5".to_string()),
            content: "FTS5 allows full-text search directly inside local SQLite without a separate vector database.".to_string(),
            source_message_id: None,
            source_message_ids: None,
            is_pinned: false,
            is_summary: true,
            is_disabled: false,
            user_approved: true,
            created_at: 2001,
            updated_at: 2001,
        };

        db.create_memory_note(&note1).unwrap();
        db.create_memory_note(&note2).unwrap();

        // Search for "safety"
        let results = db.search_memory_notes_fts("safety", Some("session-a"), 10).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "note-1");

        // Search for "SQLite vector"
        let results_sql = db.search_memory_notes_fts("SQLite vector", None, 10).unwrap();
        assert_eq!(results_sql.len(), 1);
        assert_eq!(results_sql[0].id, "note-2");

        // Delete note and verify FTS trigger deletion
        db.delete_memory_note("note-1").unwrap();
        let results_after = db.search_memory_notes_fts("safety", None, 10).unwrap();
        assert!(results_after.is_empty());
    }

    #[test]
    fn test_messages_fts5_search() {
        let db = Database::open_in_memory().unwrap();

        let session = SessionRecord {
            id: "sess-msg-test".to_string(),
            title: "FTS Message Test".to_string(),
            created_at: 100,
            updated_at: 100,
            pinned_facts: None,
            task_state: None,
        };
        db.create_session(&session).unwrap();

        let msg1 = MessageRecord {
            id: "msg-101".to_string(),
            session_id: "sess-msg-test".to_string(),
            role: "user".to_string(),
            content: "Can you explain Rust zero cost abstractions?".to_string(),
            token_count: Some(8),
            created_at: 101,
            is_pinned: false,
            metadata: None,
        };

        let msg2 = MessageRecord {
            id: "msg-102".to_string(),
            session_id: "sess-msg-test".to_string(),
            role: "assistant".to_string(),
            content: "Zero cost abstractions mean what you don't use, you don't pay for.".to_string(),
            token_count: Some(15),
            created_at: 102,
            is_pinned: false,
            metadata: None,
        };

        db.create_message(&msg1).unwrap();
        db.create_message(&msg2).unwrap();

        // Search messages for "abstractions"
        let res = db.search_messages_fts("abstractions", Some("sess-msg-test"), 10).unwrap();
        assert_eq!(res.len(), 2);

        // Search messages for "abstractions" without session filter
        let res_global = db.search_messages_fts("abstractions", None, 10).unwrap();
        assert_eq!(res_global.len(), 2);

        // Delete message and ensure FTS trigger removes it
        db.delete_message("msg-101").unwrap();
        let res_after = db.search_messages_fts("abstractions", Some("sess-msg-test"), 10).unwrap();
        assert_eq!(res_after.len(), 1);
        assert_eq!(res_after[0].id, "msg-102");
    }

    #[test]
    fn test_model_profiles_persistence() {
        let db = Database::open_in_memory().unwrap();
        let profile = ModelProfile::new(
            "Llama-3-8B-Q4_K_M",
            PathBuf::from("/models/llama3.gguf"),
            8192,
        );

        db.save_model_profile(&profile).unwrap();
        let loaded = db.get_model_profile(&profile.id).unwrap().expect("Profile not found");
        assert_eq!(loaded.name, "Llama-3-8B-Q4_K_M");
        assert_eq!(loaded.context_capacity, 8192);
        assert_eq!(loaded.effective_context_limit(), 8192);

        let all = db.list_model_profiles().unwrap();
        assert_eq!(all.len(), 1);

        db.delete_model_profile(&profile.id).unwrap();
        assert!(db.get_model_profile(&profile.id).unwrap().is_none());
    }

    #[test]
    fn test_file_db_with_storage_policy() {
        let temp_dir = std::env::temp_dir().join("lowcon_test_db");
        let _ = std::fs::remove_dir_all(&temp_dir);
        let policy = StorageLocationPolicy::new(temp_dir.clone());

        let db_path = temp_dir.join("test_app.db");
        let db = Database::open(&db_path, &policy).expect("Failed to open DB within policy");

        let session = SessionRecord {
            id: "s-test".to_string(),
            title: "Test Session".to_string(),
            created_at: 1,
            updated_at: 1,
            pinned_facts: None,
            task_state: None,
        };
        db.create_session(&session).unwrap();

        // Ensure database files were created strictly inside temp_dir
        assert!(db_path.exists());

        // Attempting to open outside policy must fail
        let illegal_path = temp_dir.parent().unwrap().join("escaped.db");
        let err = Database::open(&illegal_path, &policy);
        assert!(err.is_err());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
