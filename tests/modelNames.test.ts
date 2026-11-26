import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelOriginIcon } from '../src/components/chat/ModelOriginIcon';
import {
  detectModelOrigin,
  formatCleanModelName,
  resolveModelDisplayName,
} from '../src/core/modelNames';

test('formatCleanModelName cleans publisher prefixes, noisy suffixes, and parameter tags', () => {
  assert.equal(formatCleanModelName('google/gemma-4-e2b'), 'Gemma 4 2B');
  assert.equal(formatCleanModelName('google/gemma-4-e4b-it'), 'Gemma 4 4B');
  assert.equal(formatCleanModelName('qwen2.5-7b-instruct'), 'Qwen 2.5 7B');
  assert.equal(formatCleanModelName('lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF'), 'Llama 3.1 8B');
  assert.equal(formatCleanModelName('openai/gpt-oss-20b'), 'GPT OSS 20B');
  assert.equal(formatCleanModelName('bartowski/DeepSeek-R1-Distill-Qwen-14B-Q4_K_M'), 'DeepSeek R1 Distill Qwen 14B Q4_K_M');
});

test('resolveModelDisplayName prefers user custom alias and falls back to auto-cleaned name', () => {
  const aliases = {
    'google/gemma-4-e2b': 'Gemma4 2B',
    'blank/model': '   ',
  };

  assert.equal(resolveModelDisplayName('google/gemma-4-e2b', aliases), 'Gemma4 2B');
  assert.equal(resolveModelDisplayName('blank/model', aliases), 'Model');
  assert.equal(resolveModelDisplayName('qwen/qwen3-8b', aliases), 'Qwen 3 8B');
});

test('detectModelOrigin identifies base model family across fine-tunes, architectures, and unknown fallbacks', () => {
  assert.equal(detectModelOrigin({ modelId: 'google/gemma-4-e2b' }), 'google');
  assert.equal(detectModelOrigin({ modelId: 'unsloth/gemma-3-4b-it-GGUF' }), 'google');
  assert.equal(detectModelOrigin({ modelId: 'qwen/qwen2.5-7b-instruct' }), 'qwen');
  assert.equal(detectModelOrigin({ modelId: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-Q4_K_M' }), 'qwen');
  assert.equal(detectModelOrigin({ modelId: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF' }), 'meta');
  assert.equal(detectModelOrigin({ modelId: 'thinking-machines/Inkling-2-Mini' }), 'inkling');
  assert.equal(detectModelOrigin({ architecture: 'mistral' }), 'mistral');
  assert.equal(detectModelOrigin({ modelId: 'custom/unknown-model-v1' }), 'default');
  assert.equal(detectModelOrigin({ backendType: 'mock', architecture: 'qwen2' }), 'default');
});

test('ModelOriginIcon renders Google, Qwen, Inkling, and fallback icons cleanly', () => {
  for (const origin of ['google', 'qwen', 'inkling', 'default'] as const) {
    const html = renderToStaticMarkup(React.createElement(ModelOriginIcon, { origin, size: 14 }));
    assert.ok(html.includes(`data-testid="model-origin-icon-${origin}"`));
  }
});
