import type { BackendType } from './types';

export type ModelOrigin =
  | 'google'
  | 'qwen'
  | 'meta'
  | 'mistral'
  | 'deepseek'
  | 'openai'
  | 'microsoft'
  | 'anthropic'
  | 'inkling'
  | 'default';

const EXACT_TOKEN_CASE: Record<string, string> = {
  gemma: 'Gemma',
  qwen: 'Qwen',
  llama: 'Llama',
  mistral: 'Mistral',
  mixtral: 'Mixtral',
  deepseek: 'DeepSeek',
  phi: 'Phi',
  gpt: 'GPT',
  oss: 'OSS',
  coder: 'Coder',
  code: 'Code',
  math: 'Math',
  nemo: 'Nemo',
  hermes: 'Hermes',
  dolphin: 'Dolphin',
  smollm: 'SmolLM',
  smollm2: 'SmolLM2',
  tinyllama: 'TinyLlama',
  granite: 'Granite',
  olmo: 'OLMo',
  yi: 'Yi',
  vl: 'VL',
  r1: 'R1',
  v2: 'V2',
  v3: 'V3',
};

const STRIP_TRAILING_TOKENS = new Set(['gguf', 'hf', 'mlx', 'instruct', 'chat', 'it']);

const QUANT_PATTERN = /^q\d+(?:_[a-z0-9]+)*$/i;
const COMPACT_E_SIZE_PATTERN = /^e(\d+(?:\.\d+)?)b$/i;
const SIZE_B_PATTERN = /^(\d+(?:\.\d+)?)([bm])$/i;
const ATTACHED_FAMILY_VERSION_PATTERN = /^(gemma|qwen|llama|phi|mistral|deepseek)(\d+(?:\.\d+)?)$/i;

function formatToken(token: string): string {
  const lower = token.toLowerCase();

  const exact = EXACT_TOKEN_CASE[lower];
  if (exact) return exact;

  const attached = ATTACHED_FAMILY_VERSION_PATTERN.exec(lower);
  if (attached) {
    const family = EXACT_TOKEN_CASE[attached[1]] ?? attached[1];
    return `${family} ${attached[2]}`;
  }

  const eSize = COMPACT_E_SIZE_PATTERN.exec(lower);
  if (eSize) {
    return `${eSize[1]}B`;
  }

  const sizeB = SIZE_B_PATTERN.exec(lower);
  if (sizeB) {
    return `${sizeB[1]}${sizeB[2].toUpperCase()}`;
  }

  if (QUANT_PATTERN.test(lower)) {
    return token.toUpperCase();
  }

  if (/^\d+(?:\.\d+)?$/.test(token)) {
    return token;
  }

  if (/^[a-z0-9]+$/.test(token)) {
    return token.charAt(0).toUpperCase() + token.slice(1);
  }

  return token;
}

/**
 * Converts raw server model identifiers (e.g. `google/gemma-4-e2b`,
 * `lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF`) into concise,
 * human-readable names (e.g. `Gemma 4 2B`, `Llama 3.1 8B`).
 */
export function formatCleanModelName(rawModelId: string): string {
  const trimmed = rawModelId.trim();
  if (!trimmed) return '';

  // Drop publisher/repo prefix such as `google/` or `lmstudio-community/`
  const slashIdx = trimmed.lastIndexOf('/');
  const leaf = slashIdx !== -1 && slashIdx < trimmed.length - 1 ? trimmed.slice(slashIdx + 1) : trimmed;

  // Split on hyphens/spaces while preserving decimal numbers (`2.5`, `3.1`) and quant tokens (`Q4_K_M`)
  let tokens = leaf
    .replace(/_/g, (match, offset: number, whole: string) => {
      // Keep underscores inside quantization identifiers like Q4_K_M
      const before = whole.slice(0, offset);
      return /(?:^|[-_\s])q\d+(?:_[a-z0-9]+)*$/i.test(before) ? match : ' ';
    })
    .split(/[-\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) return trimmed;

  // Drop leading `Meta` when immediately followed by `Llama`
  if (tokens.length > 1 && tokens[0].toLowerCase() === 'meta' && /^llama/i.test(tokens[1])) {
    tokens = tokens.slice(1);
  }

  // Strip noisy trailing packaging/format tags while keeping at least 1 token
  while (tokens.length > 1 && STRIP_TRAILING_TOKENS.has(tokens[tokens.length - 1].toLowerCase())) {
    tokens.pop();
  }

  return tokens.map(formatToken).join(' ');
}

/**
 * Resolves the display name for a model identifier, preferring any user-defined
 * custom alias and falling back to `formatCleanModelName`.
 */
export function resolveModelDisplayName(
  rawModelId: string,
  aliases?: Record<string, string>,
): string {
  const custom = aliases?.[rawModelId]?.trim();
  if (custom) return custom;
  const cleaned = formatCleanModelName(rawModelId);
  return cleaned || rawModelId;
}

function stripPublisherPrefix(raw: string): string {
  const trimmed = raw.trim();
  const slashIdx = trimmed.lastIndexOf('/');
  return slashIdx !== -1 && slashIdx < trimmed.length - 1 ? trimmed.slice(slashIdx + 1) : trimmed;
}

function detectOriginFromText(text: string): ModelOrigin | null {
  const lower = text.toLowerCase();
  if (!lower) return null;

  // Check underlying base model architecture/family first (handles fine-tunes & distills,
  // e.g. `bartowski/DeepSeek-R1-Distill-Qwen-14B` -> `qwen`, `unsloth/gemma-4-e2b` -> `google`)
  if (/\b(?:distill[-_ ]?qwen|qwen\d*|qwq)\b/i.test(lower) || /(?:^|[-_/])qwen/i.test(lower)) {
    return 'qwen';
  }
  if (
    /\b(?:distill[-_ ]?llama|codellama|meta[-_ ]?llama|llama\d*|hermes[-_ ]\d*[-_ ]?llama|tinyllama)\b/i.test(
      lower,
    ) ||
    /(?:^|[-_/])llama/i.test(lower)
  ) {
    return 'meta';
  }
  if (/\b(?:gemma\d*|codegemma|paligemma|recurrentgemma)\b/i.test(lower) || /(?:^|[-_/])gemma/i.test(lower)) {
    return 'google';
  }
  if (
    /\b(?:mistral|mixtral|codestral|devstral|mathstral|pixtral|ministral)\b/i.test(lower)
  ) {
    return 'mistral';
  }
  if (/\bdeepseek\b/i.test(lower)) {
    return 'deepseek';
  }
  if (/\bphi[-_ ]?\d/i.test(lower) || /(?:^|[-_/])phi\d/i.test(lower)) {
    return 'microsoft';
  }
  if (/\binklings?\b/i.test(lower)) {
    return 'inkling';
  }
  if (/\bgpt[-_ ]?(?:oss|\d|4o|3\.5)\b/i.test(lower)) {
    return 'openai';
  }
  if (/\bclaude\b/i.test(lower)) {
    return 'anthropic';
  }

  return null;
}

/**
 * Determines the underlying origin/provider logo from what a model is built on
 * (base model name, architecture metadata, or publisher prefix as fallback).
 */
export function detectModelOrigin(params: {
  modelId?: string;
  profileName?: string;
  architecture?: string;
  backendType?: BackendType;
}): ModelOrigin {
  if (params.backendType === 'mock') {
    return 'default';
  }

  // 1. Base model leaf name (ignoring uploader org like `bartowski/` or `unsloth/`)
  const leafId = params.modelId ? stripPublisherPrefix(params.modelId) : '';
  const fromLeaf = detectOriginFromText(leafId);
  if (fromLeaf) return fromLeaf;

  // 2. Loaded GGUF/profile architecture field (e.g. `qwen2`, `gemma3`, `llama`, `mistral`)
  if (params.architecture) {
    const fromArch = detectOriginFromText(params.architecture);
    if (fromArch) return fromArch;
  }

  // 3. Profile display name (skipping generic built-in placeholder names like `LM Studio · Local Server`)
  if (params.profileName && !/local server|offline mock/i.test(params.profileName)) {
    const fromProfile = detectOriginFromText(params.profileName);
    if (fromProfile) return fromProfile;
  }

  // 4. Publisher prefix fallback (e.g. `google/...`, `thinking-machines/...`)
  if (params.modelId && params.modelId.includes('/')) {
    const org = params.modelId.slice(0, params.modelId.indexOf('/')).toLowerCase();
    if (org === 'google') return 'google';
    if (org === 'qwen') return 'qwen';
    if (org === 'meta-llama' || org === 'meta') return 'meta';
    if (org === 'mistralai' || org === 'mistral') return 'mistral';
    if (org === 'deepseek-ai' || org === 'deepseek') return 'deepseek';
    if (org === 'microsoft') return 'microsoft';
    if (org === 'openai') return 'openai';
    if (org === 'anthropic') return 'anthropic';
    if (org.includes('thinking') || org.includes('inkling')) return 'inkling';
  }

  return 'default';
}
