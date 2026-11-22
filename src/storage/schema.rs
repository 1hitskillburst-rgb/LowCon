use rusqlite::{Connection, Result};

pub const CURRENT_SCHEMA_VERSION: i32 = 1;

pub fn apply_migrations(conn: &mut Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
         );"
    )?;

    let current_version: i32 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations;",
        [],
        |row| row.get(0),
    )?;

    if current_version < 1 {
        apply_migration_v1(conn)?;
    }

    Ok(())
}

fn apply_migration_v1(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;

    tx.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            pinned_facts TEXT,
            task_state TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            token_count INTEGER,
            created_at INTEGER NOT NULL,
            is_pinned INTEGER NOT NULL DEFAULT 0,
            metadata TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at ASC);

        CREATE TABLE IF NOT EXISTS memory_notes (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            title TEXT,
            content TEXT NOT NULL,
            source_message_id TEXT,
            is_pinned INTEGER NOT NULL DEFAULT 0,
            is_summary INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memory_notes_session ON memory_notes(session_id);
        CREATE INDEX IF NOT EXISTS idx_memory_notes_pinned ON memory_notes(is_pinned);

        CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
            id UNINDEXED,
            title,
            content
        );

        CREATE TRIGGER IF NOT EXISTS trig_memory_notes_ai AFTER INSERT ON memory_notes
        BEGIN
            INSERT INTO memory_notes_fts(id, title, content)
            VALUES (new.id, COALESCE(new.title, ''), new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS trig_memory_notes_ad AFTER DELETE ON memory_notes
        BEGIN
            DELETE FROM memory_notes_fts WHERE id = old.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trig_memory_notes_au AFTER UPDATE ON memory_notes
        BEGIN
            DELETE FROM memory_notes_fts WHERE id = old.id;
            INSERT INTO memory_notes_fts(id, title, content)
            VALUES (new.id, COALESCE(new.title, ''), new.content);
        END;

        CREATE TABLE IF NOT EXISTS model_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            context_capacity INTEGER NOT NULL,
            context_override INTEGER,
            chat_template TEXT NOT NULL,
            settings_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS vault_metadata (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL
        );

        INSERT INTO schema_migrations (version, applied_at)
        VALUES (1, unixepoch());
        "
    )?;

    tx.commit()?;
    Ok(())
}
