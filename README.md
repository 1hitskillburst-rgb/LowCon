# LowCon — Local Model & Low-Context Workbench

LowCon is a local-first workbench engineered for small and medium language models with tight context windows (2K–32K tokens). It enforces deterministic token budgeting, unconditional pinned project rules, full-corpus BM25 memory retrieval, real-time prompt inspection, and authenticated local storage encryption.

## Architecture & Key Guarantees

- **Runtime**: Vite 6 + React 18 + TypeScript + Tailwind CSS v4 serving on `0.0.0.0:3000`, with a strict loopback-only Vite middleware proxy (`/api/local-llm/models` and `/api/local-llm/chat`) for optional local LM Studio / OpenAI-compatible servers.
- **Budget-First Context Assembly (`src/core/context.ts`)**:
  - Reserves user-configured Reply Reserve % and Safety Margin % first (`promptBudget + outputReserve + safetyMargin <= modelLimit`).
  - Packs core instructions, pinned rules, active task state, scored memory notes, and recent turns deterministically with a 4-stage overflow pass.
  - Aborts explicitly with an actionable error when mandatory content exceeds `promptBudget` (zero silent user-message clipping or unbudgeted fallback).
  - Produces both exact chat-template renderings (`ChatML`, `Llama3`, `Llama2`, `Mistral`, `Gemma`, `Raw`) and structured OpenAI `messages[]` arrays to prevent server-side double-templating.
- **Memory & Pinned Rules (`src/core/memory.ts`)**:
  - Pinned project rules are injected unconditionally on every turn regardless of lexical query match.
  - Unpinned notes are ranked across the entire local library using Okapi BM25 + session match + pin boost + exponential recency decay.
- **Inference Lifecycle (`src/core/inference.ts`)**:
  - Auto-loads the active model profile on startup and tracks real `WorkerStatus` transitions (`unloaded`, `loading`, `loaded`, `generating`, `error`).
  - Caps output generation via `maxTokens = outputReserve` and isolates streaming tokens strictly by originating `sessionId`.
- **GGUF Inspector (`src/core/gguf.ts`)**:
  - Parses GGUF v1/v2/v3 binary headers directly in-browser to extract architecture, quantization, native context length, tensor count, and chat template.
- **Local Privacy & Vault (`src/core/vault.ts`, `src/core/privacy.ts`)**:
  - Seals persisted workspace data using Web Crypto PBKDF2-SHA256 (150,000 iterations) + AES-256-GCM authenticated encryption, purging plaintext storage until unlocked.
  - Enforces strict loopback validation (`127.0.0.1`, `localhost`, `::1`) and Unicode-safe diagnostic log redaction.

## Scripts

- `npm run dev` — Start dev server on `http://0.0.0.0:3000`
- `npm run build` — Type-check (`tsc --noEmit`) and build production bundle
- `npm run lint` — Run ESLint across `src/`
- `npm test` — Execute unit tests via Node's built-in test runner (`tsx --test`)
