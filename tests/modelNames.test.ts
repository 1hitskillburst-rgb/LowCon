import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCleanModelName, resolveModelDisplayName } from '../src/core/modelNames';

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
