# LowCon

> **A Private, Low-Context Local LLM Desktop Workbench**  
> Engineered for deterministic context budget enforcement, zero-network air-gapped privacy, local SQLite persistence, and local model inference (LM Studio, Ollama, native GGUF) on resource-constrained context windows (2K–8K tokens).

---

## Overview

Modern small language models (such as Qwen 2.5 0.5B–3B, Llama 3.2 1B–3B, Phi-3.5, and Gemma 2 2B) offer fast local execution on commodity consumer hardware, but degrade rapidly when context windows become saturated. Traditional chat interfaces silently truncate past messages or fail unpredictably when limits are exceeded.

**LowCon** solves this through a **budget-first context assembly pipeline** paired with an **air-gapped, zero-cloud architecture**. Every token is budgeted before inference, ensuring that prompt assembly never overflows model capacity, the current user message is never silently clipped, and no byte of prompt data or conversation history ever leaves the local machine.

---

## Quick Start for Casual Users (Windows)

You do **not** need Rust or developer tools installed to run LowCon once compiled:

1. Locate the standalone executable:
   ```
   target\release\lowcon.exe
   ```
2. Double-click `lowcon.exe` (or run it from PowerShell/CMD).
3. The calm editorial desktop workbench will launch immediately at `1280x840` resolution.
4. All chat sessions, messages, and memory notes are stored locally in an embedded SQLite database.

---

## LM Studio & Local Server Setup Guide

LowCon connects seamlessly to local OpenAI-compatible inference servers such as **LM Studio**, **Ollama**, or **LocalAI** using strict local-loopback HTTP/SSE streaming.

### Step 1: Install & Launch LM Studio
* Download and install LM Studio from [lmstudio.ai](https://lmstudio.ai/).
* Download any small, efficient model suitable for 2K–8K context work (e.g., `Qwen2.5-Coder-1.5B-Instruct-GGUF`, `Llama-3.2-3B-Instruct-GGUF`, or `Phi-3.5-mini-instruct-GGUF`).

### Step 2: Start the Local Inference Server
* In LM Studio, click on the **Developer / Local Server** tab (icon `<->` on the left sidebar).
* Select your downloaded model from the dropdown at the top.
* Ensure the server port is set to `1234` (the default).
* Click **Start Server**. The local server will listen at `http://127.0.0.1:1234/v1`.

### Step 3: Connect LowCon to LM Studio
1. Launch **LowCon** and click on **Settings** in the left navigation sidebar.
2. Under the **LM Studio / Local Inference Server** card:
   * Verify the endpoint is set to `http://127.0.0.1:1234/v1` (or enter `http://localhost:11434/v1` if using Ollama).
   * Click **Test Connection & Fetch Models**.
   * A green status indicator will appear showing available models (e.g., `Connected: 1 model(s) available`).
   * Select your active model from the **Active Model** dropdown.
   * Ensure **LM Studio (Local Server)** is selected under **Inference Backend**.

### Step 4: Chat with Live Streaming & Real Context Budgeting
* Return to the **Chat** tab.
* The header displays the active backend pill: `LM Studio · http://127.0.0.1:1234/v1` alongside the active model name.
* Type a message and press **Send** (or `Ctrl+Enter`).
* LowCon assembles the context using strict budget invariants, passes the formatted prompt to LM Studio, and streams tokens into the assistant bubble in real-time.
* Click **Stop** at any moment for instant atomic cancellation.
* Once generation completes, the assistant response and exact token count are permanently saved to the local SQLite database.

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

### 2. Air-Gapped Privacy & Local Loopback Boundaries (`src/privacy/`, `src/storage/`)
* **Local-Only Boundary:** Zero connection to external internet or cloud APIs.
* **Strict Loopback Validation:** Network calls are strictly restricted to local loopback interfaces (`127.0.0.1`, `localhost`, `::1`, `0.0.0.0`). Any attempt to configure a remote endpoint (e.g., `api.openai.com` or external IPs) is immediately blocked by `is_local_endpoint` with an `InferenceError::PrivacyViolation`.
* **Path Traversal Protection:** `StorageLocationPolicy` validates all path operations and prevents directory traversal attacks.
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

### 4. Flexible Inference Backends & Background Workers (`src/inference/`)
* **LM Studio & OpenAI-Compatible Servers (`LmStudioBackend`):** High-performance streaming over local SSE with non-blocking line parsing and per-chunk atomic cancellation.
* **Pure-Rust GGUF Header Parser (`gguf.rs`):** Extracts architecture, context window, tensor count, and quantization format from local `.gguf` files without loading weights.
* **Deterministic Offline Mock (`MockInferenceBackend`):** Deterministic offline generation for automated testing, CI, and weightless development.
* **Threaded Background Worker (`InferenceWorkerHandle`):** Inference and model loading execute entirely off the UI thread; non-blocking polling at 60 FPS.
* **Dynamic Backend Switching:** Switch on the fly between LM Studio, native GGUF, and mock without restarting the app.

### 5. Calm Editorial Desktop GUI (`src/ui/`, `src/app/`)
* Built with `eframe` / `egui 0.29`.
* Editorial palette matching design specification (`#161B26`, `#444D5C`, `#F7F8F9`, `#2A3FE0`, `#F2D452`, `#1D7A4E`).
* Four primary views:
  * **Chat Workspace:** Model selector, conversation feed with aside notes and source citations, per-turn context strip, and composer with memory retrieval toggle.
  * **Right Context Panel:** Live 44px token budget meter, prompt inspector modal, and active memory list.
  * **Models View:** Local `.gguf` file loader, metadata inspector, and active backend manager.
  * **Memory View:** Real SQLite FTS5 search, pin/unpin toggles, manual note editor, and hard delete controls.
  * **Settings View:** LM Studio endpoint configuration, model test & fetch, context limit overrides, reserve percentage sliders, vault lock/unlock, and privacy policy disclosure.

---

## Project Structure

```
LowCon/
├── Cargo.toml               # Offline dependencies (local loopback ureq + SQLite bundled)
├── Cargo.lock
├── BUILD_STATE.md           # Implementation status, test results, limitations
├── README.md                # Build, run, and architecture documentation
├── src/
│   ├── main.rs              # Desktop binary entry point (eframe launch)
│   ├── lib.rs               # Library root exporting core modules
│   ├── app/                 # Application state and eframe::App trait implementation
│   │   ├── mod.rs           # Real SQLite database wiring & live streaming poll loop
│   │   └── state.rs         # LowConApp state, turn context models, and inspector state
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
│   ├── inference/           # Model loading, GGUF parser, LM Studio, worker
│   │   ├── mod.rs
│   │   ├── adapter.rs       # Native offline adapter & privacy boundary checks
│   │   ├── backend.rs       # InferenceBackend trait and generation types
│   │   ├── gguf.rs          # Pure-Rust GGUF v1/v2/v3 header parser
│   │   ├── lm_studio.rs     # Local LM Studio / Ollama SSE streaming backend & loopback check
│   │   ├── mock.rs          # Deterministic offline mock backend
│   │   └── worker.rs        # Threaded worker handle with backend switching & cancellation
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
│   │   ├── db.rs            # Database handle, connections, WAL mode, FTS5 triggers
│   │   ├── schema.rs        # Versioned SQLite migrations (v1 and v2 with FTS5)
│   │   └── vault.rs         # ChaCha20-Poly1305 + Argon2id envelope vault
│   └── ui/                  # Native egui widgets and layout views
│       ├── mod.rs
│       ├── chat_view.rs     # Conversation stream, live streaming tokens, context strip
│       ├── components.rs    # Budget bars, badge pills, token formatters
│       ├── context_panel.rs # Live context stack and memory items
│       ├── memory_view.rs   # Real SQLite FTS5 search, note editor, hard delete
│       ├── models_view.rs   # GGUF model loader and metadata inspector
│       ├── nav.rs           # Sidebar navigation and offline badge
│       ├── prompt_inspector.rs # Exact prompt modal and breakdown tables
│       ├── settings_view.rs # LM Studio config, context limits, vault controls
│       └── theme.rs         # Calm editorial color palette and styling
└── tests/                   # Integration tests
    ├── context_assembly_tests.rs # 2K/4K/8K limits, budget invariants, trimming
    └── inference_lifecycle.rs    # Worker threading, cancellation, GGUF parsing
```

---

## Developer Guide: Building & Testing

### Prerequisites

* **Rust Toolchain:** Rust 2021 edition (Rust 1.75.0 or later recommended).
  ```bash
  rustc --version
  cargo --version
  ```
* **Platform Dependencies for GUI (`egui`/`eframe`):**
  * **Windows / macOS:** Standard system toolchain (MSVC on Windows, Xcode CLI on macOS).
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

## Running the Automated Test Suite

LowCon includes comprehensive unit and integration test coverage across all modules.

Execute all 75 automated tests:
```bash
cargo test --all
```

Run specific test suites:
```bash
# Context assembly budget invariants and trimming
cargo test --test context_assembly_tests

# Inference worker lifecycle, cancellation, and GGUF parsing
cargo test --test inference_lifecycle

# Unit tests for storage, memory FTS5, LM Studio loopback, and privacy guardrails
cargo test --lib
```

---

## Privacy & Security Verification

LowCon enforces strict privacy invariants:

1. **Air-Gapped & Local-Loopback Operation:** No external network calls exist in the binary. Verify with:
   ```bash
   cargo tree -i reqwest -i hyper -i curl
   # (Outputs: nothing to print)
   ```
2. **Strict Loopback Enforcement:** `is_local_endpoint` verifies that all HTTP communication targets `127.0.0.1`, `localhost`, `[::1]`, or `0.0.0.0`. Remote cloud endpoints are rejected at creation time.
3. **Local Storage Boundary:** All session data, messages, and model profile metadata reside in a local SQLite database in your user configuration directory or specified local path.
4. **Encrypted Vault:** Sensitive memories and notes can be encrypted with an Argon2id-derived ChaCha20-Poly1305 key. Keys are zeroed out of memory when the vault is locked or dropped.
5. **Offline GGUF Execution:** Models must be loaded from local files on disk; remote download URLs are strictly rejected.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
