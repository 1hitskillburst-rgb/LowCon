# LowCon

> **A Private, Low-Context Local LLM Desktop Workbench**  
> Engineered for deterministic context budget enforcement, zero-network air-gapped privacy, and local GGUF model execution on resource-constrained context windows (2K–8K tokens).

---

## Overview

Modern small language models (such as Qwen 2.5 0.5B–3B, Llama 3.2 1B–3B, Phi-3.5, and Gemma 2 2B) offer fast local execution on commodity consumer hardware, but degrade rapidly when context windows become saturated. Traditional chat interfaces silently truncate past messages or fail unpredictably when limits are exceeded.

**LowCon** solves this through a **budget-first context assembly pipeline** paired with an **air-gapped, zero-network architecture**. Every token is budgeted before inference, ensuring that prompt assembly never overflows model capacity, the current user message is never silently clipped, and no byte of prompt data or conversation history ever leaves the local machine.

---

## Architectural Principles & Core Features

### 1. Budget-First Context Assembly (`src/context/`)
* **Strict Context Invariant:**
  $$\text{prompt\_tokens} + \text{max\_output\_tokens} + \text{safety\_margin} \le \text{model\_context\_limit}$$
* **Default Partition:** 20% output reserve, 5% safety margin, user-configurable per model profile with minimum token floors.
* **Deterministic Priority Packing:**
  1. Minimal core instructions & chat template formatting
  2. Current user message (**never** silently clipped or truncated)
  3. Explicitly pinned instructions and facts
  4. Compact active task state (goals, constraints, decisions)
  5. Retrieved memory excerpts (scored notes)
  6. Newest conversation turns (packed backwards chronologically)
  7. Optional summarized context
* **4-Stage Deterministic Overflow Trimming:**
  1. Drop lowest-scoring unpinned memory retrieval notes
  2. Compress summaries to compact notes, then drop unpinned summaries
  3. Drop oldest unpinned conversation turns
  4. Strip optional metadata
  * If mandatory items exceed budget, LowCon emits an explicit, actionable `ContextError::MandatoryContentExceedsBudget` rather than silently discarding context.
* **Prompt Inspector:**
  * Exact rendered prompt string visualization
  * Per-section token breakdown (visual 44px stacked bar meter)
  * Complete audit trail of included items and excluded candidates with explainable rejection reasons.

### 2. Air-Gapped Privacy & Vault Security (`src/privacy/`, `src/storage/`)
* **Zero Runtime Networking:** Absolutely no HTTP, HTTPS, sockets, WebSockets, DNS queries, or IPC network listeners. Audited dependency tree.
* **Boundary Enforcement:** `StorageLocationPolicy` validates all path operations and prevents directory traversal attacks.
* **ChaCha20-Poly1305 Encrypted Vault:** Authenticated encryption with Argon2id password key derivation (64MB memory cost, 3 iterations) and automatic memory `Zeroize` on drop.
* **Redacted Local-Only Diagnostics:** In-memory diagnostic logger disabled by default. If enabled, prompts, tokens, and encryption keys are scrubbed automatically.

### 3. Local Memory & FTS5 Retrieval (`src/memory/`)
* **Full-Text Search:** Integrated SQLite FTS5 search index with triggers across stored messages and memory notes.
* **Composite Ranking:**
  $$\text{Score} = \text{BM25} + \text{SessionContextBonus} + \text{PinBoost} + \text{RecencyDecay}(t_{1/2})$$
* **Memory Lifecycle & Governance:**
  * Create, edit, pin, disable, and hard delete notes.
  * Extracted summaries require explicit user approval (`user_approved: bool`) before entering the prompt candidate pool.
  * Hard delete permanently purges records from SQLite tables and FTS5 indexes.

### 4. Local GGUF Inference & Background Workers (`src/inference/`)
* **Header Inspection:** Pure-Rust zero-dependency GGUF parser extracts architecture, context window, tensor count, and quantization format from local `.gguf` files without loading weights.
* **Threaded Non-Blocking Worker:** Inference and model loading execute entirely on background worker threads with crossbeam/mpsc message channels. The UI thread remains fluid at 60 FPS.
* **Atomic Cancellation:** Instant cancellation via atomic cancellation tokens without memory leaks or worker hang.
* **Deterministic Offline Mock:** Built-in mock backend enabling full headless lifecycle testing in environments without pre-downloaded model weights.

### 5. Calm Editorial Desktop GUI (`src/ui/`, `src/app/`)
* Built with `eframe` / `egui 0.29`.
* Editorial palette matching design specification (`#161B26`, `#444D5C`, `#F7F8F9`, `#2A3FE0`, `#F2D452`, `#1D7A4E`).
* Four primary views:
  * **Chat Workspace:** Model selector, conversation feed with aside notes and source citations, per-turn context strip, and composer with memory retrieval toggle.
  * **Right Context Panel:** Live 44px token budget meter, prompt inspector modal, and active memory list.
  * **Models View:** Local `.gguf` file loader, metadata inspector, and active backend manager.
  * **Memory View:** FTS5 search, pin/unpin toggles, manual note editor, and hard delete controls.
  * **Settings View:** Context limit overrides, reserve percentage sliders, vault lock/unlock, and offline boundary disclosure.

---

## Project Structure

```
LowCon/
├── Cargo.toml               # Strictly offline dependencies (zero network crates)
├── Cargo.lock
├── BUILD_STATE.md           # Implementation status, test results, limitations
├── README.md                # Build, run, and architecture documentation
├── src/
│   ├── main.rs              # Desktop binary entry point (eframe launch)
│   ├── lib.rs               # Library root exporting core modules
│   ├── app/                 # Application state and eframe::App trait implementation
│   │   ├── mod.rs
│   │   └── state.rs
│   ├── config/              # AppSettings, BudgetPartition, ModelProfile
│   │   ├── mod.rs
│   │   └── settings.rs
│   ├── context/             # Budget-first context assembly engine
│   │   ├── mod.rs
│   │   ├── assembly.rs      # Deterministic priority packing & 4-stage overflow trimming
│   │   ├── budget.rs        # Invariant calculation: prompt + reserve + margin <= limit
│   │   ├── candidate.rs     # Typed context items (Core, User, Pinned, State, Memory, Turns)
│   │   ├── inspector.rs     # Inspection models and UI breakdown mappings
│   │   ├── template.rs      # ChatML, Llama3, Llama2, Mistral, Gemma, Raw templates
│   │   └── tokenizer.rs     # Tokenizer trait, ConservativeEstimator, ExactMockTokenizer
│   ├── inference/           # Model loading, GGUF parser, background worker
│   │   ├── mod.rs
│   │   ├── adapter.rs       # Native offline adapter & privacy boundary checks
│   │   ├── backend.rs       # InferenceBackend trait and generation types
│   │   ├── gguf.rs          # Pure-Rust GGUF v1/v2/v3 header parser
│   │   ├── mock.rs          # Deterministic offline mock backend
│   │   └── worker.rs        # Threaded worker handle with atomic cancellation
│   ├── memory/              # SQLite FTS5 memory notes and retrieval engine
│   │   ├── mod.rs
│   │   ├── engine.rs        # MemoryEngine CRUD, hard delete, summary approval
│   │   ├── fts.rs           # SQLite FTS5 query sanitization and token escaping
│   │   ├── models.rs        # MemoryNote, RetrievalOptions, ScoredMemoryNote
│   │   ├── scoring.rs       # BM25 + context bonus + pin boost + recency decay
│   │   └── tests.rs         # Unit tests for memory engine
│   ├── privacy/             # Offline invariants, directory sandbox, diagnostic policy
│   │   ├── mod.rs
│   │   ├── diagnostics.rs   # Redacting diagnostic logger (disabled by default)
│   │   └── guardrails.rs    # OfflineStatus and StorageLocationPolicy
│   ├── storage/             # SQLite storage and encrypted vault
│   │   ├── mod.rs
│   │   ├── db.rs            # Database handle, connections, WAL mode
│   │   ├── schema.rs        # Versioned SQLite migrations (v1 and v2 with FTS5)
│   │   └── vault.rs         # ChaCha20-Poly1305 + Argon2id envelope vault
│   └── ui/                  # Native egui widgets and layout views
│       ├── mod.rs
│       ├── chat_view.rs     # Conversation stream, composer, context strip
│       ├── components.rs    # Budget bars, badge pills, token formatters
│       ├── context_panel.rs # Live context stack and memory items
│       ├── memory_view.rs   # Memory note search, filter, edit, delete
│       ├── models_view.rs   # GGUF model loader and metadata inspector
│       ├── nav.rs           # Sidebar navigation and offline badge
│       ├── prompt_inspector.rs # Exact prompt modal and breakdown tables
│       ├── settings_view.rs # Context limits, vault controls, privacy policy
│       └── theme.rs         # Calm editorial color palette and styling
└── tests/                   # Integration tests
    ├── context_assembly_tests.rs # 2K/4K/8K limits, budget invariants, trimming
    └── inference_lifecycle.rs    # Worker threading, cancellation, GGUF parsing
```

---

## Getting Started

### Prerequisites

* **Rust Toolchain:** Rust 2021 edition (Rust 1.75.0 or later recommended).
  ```bash
  rustc --version
  cargo --version
  ```
* **Platform Dependencies for GUI (`egui`/`eframe`):**
  * **Windows / macOS:** No additional system packages required.
  * **Linux (X11 / Wayland):**
    ```bash
    sudo apt-get install libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev libxkbcommon-dev libfontconfig1-dev
    ```

### Building the Project

Compile in debug mode:
```bash
cargo build
```

Compile an optimized production release binary:
```bash
cargo build --release
```

The resulting executable will be located at `target/release/lowcon` (`lowcon.exe` on Windows).

### Running the Application

Launch the desktop user interface:
```bash
cargo run --release
```

---

## Running the Test Suite

LowCon includes comprehensive unit and integration test coverage across all modules.

Execute all 70 automated tests:
```bash
cargo test --all
```

Run specific test suites:
```bash
# Context assembly budget invariants and trimming
cargo test --test context_assembly_tests

# Inference worker lifecycle, cancellation, and GGUF parsing
cargo test --test inference_lifecycle

# Unit tests for storage, memory FTS5, and privacy guardrails
cargo test --lib
```

---

## Privacy & Security Verification

LowCon enforces strict privacy invariants:

1. **Air-Gapped Operation:** No network calls or socket connections exist in the binary. Verify with:
   ```bash
   cargo tree -i reqwest -i hyper -i ureq
   # (Outputs: nothing to print)
   ```
2. **Local Storage Boundary:** All session data, messages, and model profile metadata reside in a local SQLite database in your user configuration directory or specified local path.
3. **Encrypted Vault:** Sensitive memories and notes can be encrypted with an Argon2id-derived ChaCha20-Poly1305 key. Keys are zeroed out of memory when the vault is locked or dropped.
4. **Offline GGUF Execution:** Models must be loaded from local files on disk; remote download URLs are strictly rejected.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
