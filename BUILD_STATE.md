# LowCon — Build State

## Current Phase: Phase 1 & 2 Completed

### Implemented
- **Project Scaffolding & Offline Boundaries:**
  - Rust 2021 edition desktop binary scaffold (`Cargo.toml`, `.gitignore`).
  - Zero runtime networking dependencies or socket listeners.
  - Transparent security boundary disclosure (`SECURITY_BOUNDARY_DISCLOSURE`).
  - `StorageLocationPolicy` preventing path traversal and enforcing storage boundaries.
  - `DiagnosticLogger` with automatic redaction of prompts, tokens, and credentials (disabled by default).
- **Configuration & Context Budgets:**
  - `AppSettings` and `BudgetPartition` with exact invariant validation: `prompt_tokens + max_output_tokens + safety_margin <= model_context_limit`.
  - Configurable reserves (default 20% output reserve, 5% safety margin).
  - `ModelProfile` representation with context override and chat templates.
- **Local Storage & Vault:**
  - SQLite schema and transactional versioned migrations (`sessions`, `messages`, `memory_notes`, `model_profiles`, `vault_metadata`).
  - Full-text search with SQLite FTS5 and automatic triggers keeping search index in sync.
  - Cascading message deletions and pin management.
  - ChaCha20-Poly1305 authenticated envelope encryption with Argon2id key derivation and zeroize on sensitive keys.
  - `VaultManager` for locked/unlocked memory state and automatic zeroize on drop.

### Tested & Verified
- 17 unit tests passing via `cargo test --lib`:
  - `config::settings::tests::test_budget_partition_invariants`
  - `config::settings::tests::test_invalid_settings`
  - `config::settings::tests::test_json_roundtrip`
  - `privacy::guardrails::tests::test_offline_invariants`
  - `privacy::guardrails::tests::test_storage_location_policy`
  - `privacy::diagnostics::tests::test_diagnostics_disabled_by_default`
  - `privacy::diagnostics::tests::test_diagnostics_redaction`
  - `storage::db::tests::test_in_memory_db_migrations`
  - `storage::db::tests::test_sessions_and_messages_lifecycle`
  - `storage::db::tests::test_memory_notes_fts5_search`
  - `storage::db::tests::test_model_profiles_persistence`
  - `storage::db::tests::test_file_db_with_storage_policy`
  - `storage::vault::tests::test_vault_encrypt_decrypt_roundtrip`
  - `storage::vault::tests::test_vault_wrong_password_fails`
  - `storage::vault::tests::test_vault_corrupted_data_fails`
  - `storage::vault::tests::test_vault_truncated_payload_fails`
  - `storage::vault::tests::test_vault_manager_lifecycle`

### Known Limitations
- Real llama.cpp in-process backend is queued for Phase 3 (`src/inference/`).
- Budget-first context assembly engine is queued for Phase 4 (`src/context/`).
- GUI integration with `eframe`/`egui` is in progress by `@ui`.

### Next Task
- @context to implement budget-first context assembly in `src/context/`.
- @memory to build the FTS5 retrieval engine and summarization hooks in `src/memory/`.
- @inference to build the local GGUF backend and stream generation worker in `src/inference/`.
