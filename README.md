# LowCon

**A calm, private workspace for local AI models with small context windows.**

Small and medium local models (2K–32K context) silently lose track of your rules and earlier decisions when chat histories grow. **LowCon** fixes that by showing you *exactly* what fits in every prompt—reserving space for the reply first, keeping pinned project rules locked in on every turn, and letting you inspect the exact prompt before and after every message.

Everything stays on your device. LowCon runs in your browser or as a standalone desktop app (macOS, Windows, and Linux), works offline out of the box with a built-in deterministic harness, and connects directly to **LM Studio** or any local OpenAI-compatible server on `127.0.0.1`.

---

## Key Features

- **Visual Context Budget (No Silent Clipping)** — Reserves your reply space and safety margin up front. Watch every token bucket update live (`Core instructions`, `Pinned rules`, `Retrieved memory`, `Recent turns`, `Chat template`, `Free`, `Reply space`, and `Safety margin`). If a message and pinned rules exceed your budget, LowCon warns you clearly instead of silently cutting off your prompt.
- **Exact Prompt Inspector** — Inspect the exact formatted prompt (`ChatML`, `Llama3`, `Llama2`, `Mistral`, `Gemma`, `Raw`) or structured OpenAI `messages[]` array sent for every turn, including what was included and why older items were trimmed.
- **Pinned Project Rules & Local Memory** — Pin important constraints so they are *always* included on every turn regardless of how you phrase your question. Search across your full local note library using built-in BM25 + recency scoring, edit notes in place, and save useful replies directly to Memory.
- **In-App GGUF File Inspector** — Drop any `.gguf` model file (v1, v2, or v3) into the Models tab to read its architecture, quantization, native context length, tensor count, and chat template directly from the header—without loading gigabytes of weights into RAM.
- **Encrypted Local Storage Vault** — Lock your entire workspace (chats, memory notes, models, and settings) with a passphrase using AES-256-GCM + PBKDF2-SHA256. Plaintext storage is wiped until you unlock it again.
- **Strict Local-Only Privacy Boundary** — Zero cloud endpoints, zero analytics, and zero telemetry. Local server requests are restricted strictly to loopback addresses (`127.0.0.1`, `localhost`, `::1`), and optional local diagnostic logs automatically redact sensitive fields.

---

## Quick Start (Web App)

### Prerequisites
- **Node.js 22+** (`node -v`)

### Run Locally
```bash
npm install
npm run dev
```
Open **http://localhost:3000** in your browser.

### Production Web Build
```bash
npm run build
npm start
```
LowCon serves the compiled app and local LLM proxy on `http://0.0.0.0:3000` (override with `PORT` or `HOST` in your environment—see `.env.example`).

---

## Desktop App (macOS, Windows & Linux)

LowCon ships with a hardened Electron desktop shell that starts an isolated local loopback server on an ephemeral `127.0.0.1` port and loads the compiled app in a native window.

### Run Desktop Mode During Development
1. Start the dev server in one terminal:
   ```bash
   npm run dev
   ```
2. Launch the desktop window in a second terminal:
   ```bash
   npm run desktop:dev
   ```

### Build a Standalone Desktop Executable
```bash
# Build installers / executables for your current OS into release/
npm run desktop:build
```
Outputs are written to `release/`:
- **macOS**: `.dmg` disk image & `.zip` app bundle
- **Windows**: NSIS installer (`.exe`) & portable `.exe`
- **Linux**: `.AppImage` & `.tar.gz`

To build an unpacked desktop binary quickly without generating an installer archive:
```bash
npm run desktop:pack
```
The runnable binary is placed inside `release/<platform>-unpacked/`.

---

## Connecting to LM Studio (or Another Local Server)

LowCon works immediately using its built-in **Offline Mock Harness** so you can test context packing, pinned rules, and memory without extra setup. When you're ready to chat with a real local model:

1. Open **LM Studio** (or `llama-server` / Ollama's OpenAI endpoint) and start the **Local Server** on `http://127.0.0.1:1234/v1`.
2. In LowCon, go to **Settings → Local Inference Backend & LM Studio Server**.
3. Select **LM Studio / Local Server** and click **Test Connection & Fetch Models**.
4. Pick your loaded model from the dropdown and return to **Chat**.

> LowCon sends structured OpenAI `messages[]` arrays to LM Studio so your local server never double-wraps chat templates, while still enforcing your configured `Output Reply Reserve` as `max_tokens`.

---

## Project Structure

```text
lowcon/
├── server.ts                  # Unified Express entry point (dev Vite middleware + prod dist/ static)
├── server/
│   └── localLlmProxy.ts       # Strict loopback-only proxy for /api/local-llm/models & /chat
├── desktop/
│   ├── main.cjs               # Hardened Electron window & lifecycle manager
│   ├── preload.cjs            # Minimal read-only desktop bridge
│   ├── server.cjs             # Zero-dependency 127.0.0.1 loopback server for packaged binaries
│   └── electron-builder.json  # Cross-platform desktop packaging config (.dmg, .exe, .AppImage)
├── src/
│   ├── main.tsx               # React entry point
│   ├── App.tsx                # Application shell, state persistence, & inference lifecycle
│   ├── core/                  # Pure domain logic (context packer, BM25 memory, GGUF parser, AES-GCM vault)
│   └── components/
│       ├── layout/            # Workspace sidebar navigation
│       ├── chat/              # Chat transcript, composer, & context budget visualizations
│       ├── views/             # Models, Memory, & Settings views
│       └── modals/            # Prompt Inspector, Sources viewer, & Vault Lock screen
├── tests/                     # Unit tests (Node built-in test runner via tsx)
└── public/
    └── icon.svg               # LowCon vector icon
```

---

## Available Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start the development server on `http://localhost:3000` |
| `npm run build` | Type-check (`tsc --noEmit`) and create the production web bundle in `dist/` |
| `npm start` | Serve the production web bundle and local loopback proxy |
| `npm run desktop:dev` | Launch the Electron desktop window connected to the local dev server |
| `npm run desktop:pack` | Build an unpacked runnable desktop binary into `release/` |
| `npm run desktop:build` | Build platform desktop installers/executables into `release/` |
| `npm test` | Run all unit tests in `tests/` |
| `npm run lint` | Run ESLint across `src/`, `server/`, and `server.ts` |
