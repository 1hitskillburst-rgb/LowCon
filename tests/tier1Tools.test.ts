import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALL_FILE_AND_TIER1_TOOLS,
  buildAttachedFileIndex,
  CALCULATE_TOOL_DEFINITION,
  CALCULATE_TOOL_NAME,
  EDIT_FILE_TOOL_DEFINITION,
  EDIT_FILE_TOOL_NAME,
  evaluateSafeMathExpression,
  executeCalculateTool,
  executeEditFileTool,
  executeReadAttachedChunkTool,
  executeSaveMemoryNoteTool,
  executeSearchMemoryTool,
  MAX_ATTACHED_CHUNK_LINES,
  READ_ATTACHED_CHUNK_TOOL_DEFINITION,
  READ_ATTACHED_CHUNK_TOOL_NAME,
  SAVE_MEMORY_TOOL_DEFINITION,
  SAVE_MEMORY_TOOL_NAME,
  SEARCH_MEMORY_TOOL_DEFINITION,
  SEARCH_MEMORY_TOOL_NAME,
  TIER1_TOOL_DEFINITIONS,
  TIER1_TOOL_POLICY_INSTRUCTION,
} from '../src/core/tier1Tools';
import { CREATE_FILE_TOOL_NAME } from '../src/core/tools';
import type { GeneratedFileArtifact, MemoryNote } from '../src/core/types';

function makeFileArtifact(overrides: Partial<GeneratedFileArtifact> = {}): GeneratedFileArtifact {
  return {
    id: overrides.id ?? 'file_1',
    filename: overrides.filename ?? 'example.ts',
    title: overrides.title ?? 'Example',
    language: overrides.language ?? 'typescript',
    content: overrides.content ?? 'line 1\nline 2\nline 3',
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
  };
}

function makeMemoryNote(overrides: Partial<MemoryNote> = {}): MemoryNote {
  const now = 1_700_000_000_000;
  return {
    id: overrides.id ?? 'note_1',
    sessionId: overrides.sessionId,
    title: overrides.title ?? 'Default note',
    content: overrides.content ?? 'Default memory note content',
    sourceReference: overrides.sourceReference ?? 'Manual note',
    sourceMessageIds: overrides.sourceMessageIds ?? [],
    isPinned: overrides.isPinned ?? false,
    isSummary: overrides.isSummary ?? false,
    isDisabled: overrides.isDisabled ?? false,
    userApproved: overrides.userApproved ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

// ---------------------------------------------------------------------------
// Exports & tool registry sanity checks
// ---------------------------------------------------------------------------

test('tier 1 exports tool definitions, combined helper list, and concise policy instruction', () => {
  assert.equal(CALCULATE_TOOL_NAME, 'calculate');
  assert.equal(EDIT_FILE_TOOL_NAME, 'edit_file');
  assert.equal(READ_ATTACHED_CHUNK_TOOL_NAME, 'read_attached_chunk');
  assert.equal(SEARCH_MEMORY_TOOL_NAME, 'search_memory');
  assert.equal(SAVE_MEMORY_TOOL_NAME, 'save_memory_note');

  assert.equal(TIER1_TOOL_DEFINITIONS.length, 5);
  assert.deepEqual(
    TIER1_TOOL_DEFINITIONS.map((t) => t.function.name),
    [
      CALCULATE_TOOL_DEFINITION.function.name,
      EDIT_FILE_TOOL_DEFINITION.function.name,
      READ_ATTACHED_CHUNK_TOOL_DEFINITION.function.name,
      SEARCH_MEMORY_TOOL_DEFINITION.function.name,
      SAVE_MEMORY_TOOL_DEFINITION.function.name,
    ],
  );

  assert.equal(ALL_FILE_AND_TIER1_TOOLS.length, 6);
  assert.deepEqual(
    ALL_FILE_AND_TIER1_TOOLS.map((t) => t.function.name),
    [
      CREATE_FILE_TOOL_NAME,
      CALCULATE_TOOL_NAME,
      EDIT_FILE_TOOL_NAME,
      READ_ATTACHED_CHUNK_TOOL_NAME,
      SEARCH_MEMORY_TOOL_NAME,
      SAVE_MEMORY_TOOL_NAME,
    ],
  );

  for (const name of [
    CALCULATE_TOOL_NAME,
    EDIT_FILE_TOOL_NAME,
    READ_ATTACHED_CHUNK_TOOL_NAME,
    SEARCH_MEMORY_TOOL_NAME,
    SAVE_MEMORY_TOOL_NAME,
  ]) {
    assert.ok(TIER1_TOOL_POLICY_INSTRUCTION.includes(name));
  }

  const source = readFileSync(new URL('../src/core/tier1Tools.ts', import.meta.url), 'utf8');
  assert.equal(/\beval\s*\(/.test(source), false);
  assert.equal(/\bnew\s+Function\s*\(/.test(source), false);
});

// ---------------------------------------------------------------------------
// 1. calculate tool
// ---------------------------------------------------------------------------

test('calculate math mode evaluates precedence, associativity, unary ops, constants, and functions safely', () => {
  assert.equal(evaluateSafeMathExpression('2 + 3 * 4'), 14);
  assert.equal(evaluateSafeMathExpression('(2 + 3) * 4'), 20);
  assert.equal(evaluateSafeMathExpression('17 % 5'), 2);
  assert.equal(evaluateSafeMathExpression('2 ** 3 ** 2'), 512);
  assert.equal(evaluateSafeMathExpression('2 ^ 3 ^ 2'), 512);
  assert.equal(evaluateSafeMathExpression('-2 ^ 2'), -4);
  assert.equal(evaluateSafeMathExpression('(-2) ^ 2'), 4);
  assert.equal(evaluateSafeMathExpression('2 ^ -2'), 0.25);
  assert.equal(evaluateSafeMathExpression('--5 + +3'), 8);
  assert.equal(evaluateSafeMathExpression('1.5e2 / 3'), 50);

  assert.equal(evaluateSafeMathExpression('pi'), Math.PI);
  assert.equal(evaluateSafeMathExpression('e'), Math.E);
  assert.equal(evaluateSafeMathExpression('sqrt(144) + abs(-6)'), 18);
  assert.equal(evaluateSafeMathExpression('round(3.6) + floor(3.9) + ceil(3.1)'), 11);
  assert.equal(evaluateSafeMathExpression('round(pi, 2)'), 3.14);
  assert.equal(evaluateSafeMathExpression('min(10, 3, 7) + max(-5, 2, 9)'), 12);
  assert.equal(evaluateSafeMathExpression('pow(3, 4)'), 81);
  assert.equal(evaluateSafeMathExpression('log(1000)'), 3);
  assert.equal(evaluateSafeMathExpression('log(8, 2)'), 3);
  assert.ok(Math.abs(evaluateSafeMathExpression('ln(e ^ 2)') - 2) < 1e-12);
  assert.ok(Math.abs(evaluateSafeMathExpression('sin(pi / 6)') - 0.5) < 1e-12);
  assert.ok(Math.abs(evaluateSafeMathExpression('cos(0)') - 1) < 1e-12);
  assert.ok(Math.abs(evaluateSafeMathExpression('tan(pi / 4)') - 1) < 1e-12);

  const res = executeCalculateTool(JSON.stringify({ expression: '0.1 + 0.2' }));
  assert.equal(res.ok, true);
  assert.equal(res.status, 'ok');
  if (res.ok) {
    assert.equal(res.formatted, '0.3');
    const parsed = JSON.parse(res.toolResultJson) as {
      status: string;
      result: number;
      formatted: string;
    };
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.formatted, '0.3');
    assert.ok(Math.abs(parsed.result - 0.3) < 1e-12);
  }
});

test('calculate math mode rejects invalid syntax, division/modulo by zero, domain errors, and injection', () => {
  const errorCases = [
    JSON.stringify({ expression: '10 / 0' }),
    JSON.stringify({ expression: '10 % 0' }),
    JSON.stringify({ expression: 'sqrt(-4)' }),
    JSON.stringify({ expression: 'log(0)' }),
    JSON.stringify({ expression: 'ln(-1)' }),
    JSON.stringify({ expression: 'log(10, 1)' }),
    JSON.stringify({ expression: 'process.exit(1)' }),
    JSON.stringify({ expression: 'globalThis' }),
    JSON.stringify({ expression: '((1 + 2)' }),
    JSON.stringify({ expression: '1 + * 2' }),
    JSON.stringify({ expression: 'min()' }),
    JSON.stringify({ expression: 'pow(2)' }),
    JSON.stringify({ expression: '10 ** 1000' }),
    JSON.stringify({ expression: '   ' }),
    '{bad json',
  ];

  for (const raw of errorCases) {
    const res = executeCalculateTool(raw);
    assert.equal(res.ok, false, `Expected error for input: ${raw}`);
    assert.equal(res.status, 'error');
    const parsed = JSON.parse(res.toolResultJson) as { status: string; error?: string };
    assert.equal(parsed.status, 'error');
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
  }
});

test('calculate supports json_validate, regex_test, and date_diff modes', () => {
  // json_validate ok
  const validJson = executeCalculateTool(
    JSON.stringify({ mode: 'json_validate', input: '{"a":1,"b":[true,null]}' }),
  );
  assert.equal(validJson.ok, true);
  if (validJson.ok) {
    const parsed = JSON.parse(validJson.toolResultJson) as {
      status: string;
      result: { valid: boolean; type: string; keyCount: number };
      formatted: string;
    };
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.result.valid, true);
    assert.equal(parsed.result.type, 'object');
    assert.equal(parsed.result.keyCount, 2);
  }

  // json_validate error
  const invalidJson = executeCalculateTool(
    JSON.stringify({ mode: 'json_validate', input: '{"a": }' }),
  );
  assert.equal(invalidJson.ok, false);
  assert.equal(invalidJson.status, 'error');

  // regex_test with matches & zero-width guard
  const regexHit = executeCalculateTool(
    JSON.stringify({
      mode: 'regex_test',
      pattern: 'item-(\\d+)',
      flags: 'g',
      input: 'item-12 and item-345',
    }),
  );
  assert.equal(regexHit.ok, true);
  if (regexHit.ok) {
    const payload = regexHit.result as {
      matched: boolean;
      count: number;
      matches: Array<{ match: string; index: number; groups: string[] }>;
    };
    assert.equal(payload.matched, true);
    assert.equal(payload.count, 2);
    assert.deepEqual(payload.matches[0], { match: 'item-12', index: 0, groups: ['12'] });
    assert.deepEqual(payload.matches[1], { match: 'item-345', index: 12, groups: ['345'] });
  }

  // zero-width regex must not hang
  const zeroWidth = executeCalculateTool(
    JSON.stringify({ mode: 'regex_test', pattern: 'a*', flags: 'g', input: 'bb' }),
  );
  assert.equal(zeroWidth.ok, true);

  // invalid regex
  const badRegex = executeCalculateTool(
    JSON.stringify({ mode: 'regex_test', pattern: '[unclosed', input: 'abc' }),
  );
  assert.equal(badRegex.ok, false);

  // catastrophic backtracking regex patterns must be rejected before executing
  for (const unsafePattern of ['(a+)+', '(a|aa)+', '([a-z]+)*', '(a+){2,10}']) {
    const blocked = executeCalculateTool(
      JSON.stringify({
        mode: 'regex_test',
        pattern: unsafePattern,
        input: `${'a'.repeat(35)}!`,
      }),
    );
    assert.equal(blocked.ok, false, `Expected catastrophic pattern '${unsafePattern}' to be blocked`);
  }

  // safe grouped alternation regex still succeeds
  const safeGrouped = executeCalculateTool(
    JSON.stringify({
      mode: 'regex_test',
      pattern: '(foo|bar)+',
      input: 'foobar',
    }),
  );
  assert.equal(safeGrouped.ok, true);

  // date_diff valid
  const dateDiff = executeCalculateTool(
    JSON.stringify({
      mode: 'date_diff',
      start_date: '2026-01-01',
      end_date: '2026-01-06',
    }),
  );
  assert.equal(dateDiff.ok, true);
  if (dateDiff.ok) {
    const payload = dateDiff.result as { days: number; hours: number; direction: string };
    assert.equal(payload.days, 5);
    assert.equal(payload.hours, 120);
    assert.equal(payload.direction, 'future');
  }

  // invalid calendar rollover date rejected
  const badDate = executeCalculateTool(
    JSON.stringify({
      mode: 'date_diff',
      start_date: '2026-02-30',
      end_date: '2026-03-01',
    }),
  );
  assert.equal(badDate.ok, false);
});

// ---------------------------------------------------------------------------
// 2. edit_file tool
// ---------------------------------------------------------------------------

test('edit_file applies single and multi line-range edits bottom-to-top without shifting lines', () => {
  const existing = [
    makeFileArtifact({
      id: 'f1',
      filename: 'src/math.ts',
      content: 'line1\nline2\nline3\nline4\nline5\n',
    }),
  ];

  // Multi-edit: expand lines 2..2 to two lines AND replace line 4..5
  const multi = executeEditFileTool(
    JSON.stringify({
      filename: 'math.ts', // basename match
      edits: [
        { start_line: 2, end_line: 2, replacement: 'line2a\nline2b' },
        { start_line: 4, end_line: 5, replacement: 'line4_5' },
      ],
    }),
    existing,
  );

  assert.equal(multi.ok, true);
  if (multi.ok) {
    assert.equal(multi.artifact.id, 'f1');
    assert.equal(multi.artifact.filename, 'src/math.ts');
    assert.equal(multi.artifact.content, 'line1\nline2a\nline2b\nline3\nline4_5\n');
    assert.equal(multi.linesChanged, 4); // 2 added/changed at L2 + 2->1 at L4-5
    assert.ok(multi.previewDiff.includes('+ line2a'));
    assert.ok(multi.previewDiff.includes('- line4'));

    const parsed = JSON.parse(multi.toolResultJson) as {
      status: string;
      filename: string;
      linesChanged: number;
      totalLines: number;
      previewDiff: string;
      message: string;
    };
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.filename, 'src/math.ts');
    assert.match(parsed.message, /Do NOT paste the full file/i);
  }
});

test('edit_file supports exact old_text/new_text edits, case-insensitive lookup, and clear errors', () => {
  const existing = [
    makeFileArtifact({
      id: 'f1',
      filename: 'app.py',
      language: 'python',
      content: 'def greet():\n    return "hi"\n\ndef bye():\n    return "hi"\n',
    }),
  ];

  // Ambiguous old_text without replace_all -> error
  const ambiguous = executeEditFileTool(
    JSON.stringify({
      filename: 'APP.PY',
      old_text: 'return "hi"',
      new_text: 'return "hello"',
    }),
    existing,
  );
  assert.equal(ambiguous.ok, false);

  // Unique old_text with surrounding context -> ok
  const unique = executeEditFileTool(
    JSON.stringify({
      filename: 'APP.PY',
      old_text: 'def greet():\n    return "hi"',
      new_text: 'def greet(name: str):\n    return f"hello {name}"',
    }),
    existing,
  );
  assert.equal(unique.ok, true);
  if (unique.ok) {
    assert.ok(unique.artifact.content.includes('def greet(name: str):'));
    assert.ok(unique.artifact.content.includes('def bye():\n    return "hi"'));
  }

  // Missing file lists available filenames
  const missingFile = executeEditFileTool(
    JSON.stringify({
      filename: 'nope.py',
      old_text: 'a',
      new_text: 'b',
    }),
    existing,
  );
  assert.equal(missingFile.ok, false);
  if (!missingFile.ok) {
    assert.ok(missingFile.error.includes('app.py'));
  }

  // Overlapping line-range edits rejected
  const overlap = executeEditFileTool(
    JSON.stringify({
      filename: 'app.py',
      edits: [
        { start_line: 1, end_line: 3, replacement: 'x' },
        { start_line: 2, end_line: 4, replacement: 'y' },
      ],
    }),
    existing,
  );
  assert.equal(overlap.ok, false);

  // Tolerates null/empty schema-filler fields and start_line hints alongside old_text/new_text
  const fillerAndHint = executeEditFileTool(
    JSON.stringify({
      filename: 'app.py',
      edits: [
        {
          start_line: 1,
          end_line: 2,
          replacement: '',
          old_text: 'def greet():\n    return "hi"',
          new_text: 'def greet():\n    return "hey"',
          replace_all: null,
        },
      ],
    }),
    existing,
  );
  assert.equal(fillerAndHint.ok, true);
  if (fillerAndHint.ok) {
    assert.ok(fillerAndHint.artifact.content.includes('return "hey"'));
  }

  // Tolerates synonym replacement with old_text
  const synonymRes = executeEditFileTool(
    JSON.stringify({
      filename: 'app.py',
      edits: [
        { old_text: 'def bye():\n    return "hi"', replacement: 'def bye():\n    return "cya"' },
      ],
    }),
    existing,
  );
  assert.equal(synonymRes.ok, true);
  if (synonymRes.ok) {
    assert.ok(synonymRes.artifact.content.includes('return "cya"'));
  }
});

// ---------------------------------------------------------------------------
// 3. read_attached_chunk & buildAttachedFileIndex
// ---------------------------------------------------------------------------

test('buildAttachedFileIndex builds compact index with stats and capped outline entries', () => {
  const lines = [
    '# System Overview',
    'Intro text.',
    ...Array.from({ length: 20 }, (_, i) => `export function helper${i}(x: number) { return x; }`),
  ];
  const index = buildAttachedFileIndex('helpers.ts', lines.join('\n'));
  assert.ok(index.includes('helpers.ts'));
  assert.ok(index.includes('22 lines'));
  assert.ok(index.includes('bytes'));
  assert.ok(index.includes('L1: # System Overview'));
  assert.ok(index.includes('L3: export function helper0'));
  // Capped at 15 entries (helper0..helper13 plus heading = 15)
  assert.equal(index.includes('helper14'), false);
});

test('executeReadAttachedChunkTool paginates lines, caps at 120 lines, and handles single-file default', () => {
  const content250 = Array.from({ length: 250 }, (_, i) => `row ${i + 1}`).join('\n');
  const attached = [{ name: 'big_log.txt', content: content250 }];

  // Omit filename when only 1 attached; request 1..200 -> capped to 1..120
  const chunk1 = executeReadAttachedChunkTool(
    JSON.stringify({ start_line: 1, end_line: 200 }),
    attached,
  );
  assert.equal(chunk1.ok, true);
  if (chunk1.ok) {
    assert.equal(chunk1.filename, 'big_log.txt');
    assert.equal(chunk1.startLine, 1);
    assert.equal(chunk1.endLine, MAX_ATTACHED_CHUNK_LINES);
    assert.equal(chunk1.linesReturned, MAX_ATTACHED_CHUNK_LINES);
    assert.equal(chunk1.totalLines, 250);
    assert.equal(chunk1.hasMore, true);
    assert.equal(chunk1.capped, true);
    assert.ok(chunk1.content.startsWith('1: row 1\n'));
    assert.ok(chunk1.content.endsWith('120: row 120'));

    const parsed = JSON.parse(chunk1.toolResultJson) as {
      has_more: boolean;
      next_start_line: number;
    };
    assert.equal(parsed.has_more, true);
    assert.equal(parsed.next_start_line, 121);
  }

  // Final chunk -> hasMore: false
  const chunk3 = executeReadAttachedChunkTool(
    JSON.stringify({ start_line: 241, end_line: 260 }),
    attached,
  );
  assert.equal(chunk3.ok, true);
  if (chunk3.ok) {
    assert.equal(chunk3.endLine, 250);
    assert.equal(chunk3.linesReturned, 10);
    assert.equal(chunk3.hasMore, false);
  }

  // Multiple attached files without filename -> error listing names
  const multiError = executeReadAttachedChunkTool(JSON.stringify({ start_line: 1 }), [
    { name: 'a.txt', content: 'alpha' },
    { name: 'b.txt', content: 'beta' },
  ]);
  assert.equal(multiError.ok, false);
  if (!multiError.ok) {
    assert.ok(multiError.error.includes('a.txt'));
    assert.ok(multiError.error.includes('b.txt'));
  }

  // Explicit mismatching filename even with 1 attached file -> error
  const wrongName = executeReadAttachedChunkTool(
    JSON.stringify({ filename: 'missing.txt' }),
    attached,
  );
  assert.equal(wrongName.ok, false);
});

test('executeReadAttachedChunkTool can inspect generated session files before executeEditFileTool', () => {
  const generated = makeFileArtifact({
    id: 'file_2048',
    filename: '2048.html',
    title: '2048 Game',
    language: 'html',
    content: [
      '<!doctype html>',
      '<html>',
      '<body>',
      '  <script>',
      '    function spawnTile() { return 2; }',
      '  </script>',
      '</body>',
      '</html>',
    ].join('\n'),
  });

  const readableFiles = [
    { name: 'notes.txt', content: 'user note' },
    { name: generated.filename, content: generated.content },
  ];

  const chunk = executeReadAttachedChunkTool(
    JSON.stringify({ filename: '2048.html', start_line: 4, end_line: 6 }),
    readableFiles,
  );
  assert.equal(chunk.ok, true);
  if (chunk.ok) {
    assert.equal(chunk.filename, '2048.html');
    assert.ok(chunk.content.includes('5:     function spawnTile() { return 2; }'));
  }

  const editRes = executeEditFileTool(
    JSON.stringify({
      filename: '2048.html',
      edits: [
        {
          old_text: '    function spawnTile() { return 2; }',
          new_text: '    function spawnTile() { return Math.random() < 0.1 ? "powerup" : 2; }',
        },
      ],
    }),
    [generated],
  );
  assert.equal(editRes.ok, true);
  if (editRes.ok) {
    assert.ok(editRes.artifact.content.includes('"powerup"'));
  }
});

// ---------------------------------------------------------------------------
// 4. search_memory & save_memory_note
// ---------------------------------------------------------------------------

test('executeSearchMemoryTool uses BM25 retrieval, respects disabled/unapproved/session filters, and caps limit 1..8', () => {
  const notes: MemoryNote[] = [
    ...Array.from({ length: 12 }, (_, i) =>
      makeMemoryNote({
        id: `n_${i}`,
        title: `Topic ${i}`,
        content: `Shared architecture keyword lowcon_cache item ${i}`,
        updatedAt: 1_700_000_000_000 + i * 1000,
      }),
    ),
    makeMemoryNote({
      id: 'disabled_hit',
      title: 'Disabled Note',
      content: 'lowcon_cache disabled secret',
      isDisabled: true,
    }),
    makeMemoryNote({
      id: 'unapproved_summary',
      title: 'Unapproved Summary',
      content: 'lowcon_cache draft summary',
      isSummary: true,
      userApproved: false,
    }),
    makeMemoryNote({
      id: 'other_session',
      sessionId: 'sess_other',
      title: 'Other Session Note',
      content: 'lowcon_cache isolated session detail',
    }),
  ];

  // Limit > 8 is capped to 8; disabled, unapproved summary, and other-session notes are excluded
  const res = executeSearchMemoryTool(
    JSON.stringify({ query: 'lowcon_cache', limit: 50 }),
    notes,
    'sess_active',
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.count, 8);
    assert.equal(res.results.length, 8);
    const ids = new Set(res.results.map((r) => r.id));
    assert.equal(ids.has('disabled_hit'), false);
    assert.equal(ids.has('unapproved_summary'), false);
    assert.equal(ids.has('other_session'), false);
    for (const item of res.results) {
      assert.equal(typeof item.score, 'number');
      assert.ok(item.score > 0);
      assert.ok(typeof item.sourceReference === 'string');
    }
  }

  // Empty query without pinned_only -> error
  const emptyQuery = executeSearchMemoryTool(JSON.stringify({ query: '   ' }), notes);
  assert.equal(emptyQuery.ok, false);
});

test('executeSaveMemoryNoteTool validates inputs and builds MemoryNote cleanly', () => {
  const created = executeSaveMemoryNoteTool(
    JSON.stringify({
      title: 'Preferred Test Runner',
      content: 'Use node:test via tsx --test tests/*.test.ts',
      is_pinned: true,
    }),
    () => 'abcd1234-ef56',
    'Tier 1 Tooling',
    'sess_123',
    { nowMs: 1_700_000_123_000 },
  );

  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.note.id, 'note_abcd1234');
    assert.equal(created.note.sessionId, 'sess_123');
    assert.equal(created.note.title, 'Preferred Test Runner');
    assert.equal(created.note.content, 'Use node:test via tsx --test tests/*.test.ts');
    assert.equal(created.note.isPinned, true);
    assert.equal(created.note.isSummary, false);
    assert.equal(created.note.isDisabled, false);
    assert.equal(created.note.userApproved, true);
    assert.ok(created.note.sourceReference.startsWith('Saved via AI tool'));
    assert.ok(created.note.sourceReference.includes('Tier 1 Tooling'));
    assert.equal(created.note.createdAt, 1_700_000_123_000);

    // Caller override of userApproved=false works
    const unapproved = executeSaveMemoryNoteTool(
      JSON.stringify({ title: 'Draft', content: 'Review first' }),
      () => '99998888',
      undefined,
      undefined,
      { userApproved: false },
    );
    assert.equal(unapproved.ok, true);
    if (unapproved.ok) {
      assert.equal(unapproved.note.userApproved, false);
      assert.equal(unapproved.note.sourceReference, 'Saved via AI tool');
    }
  }

  // Validation errors
  assert.equal(
    executeSaveMemoryNoteTool(JSON.stringify({ title: '', content: 'x' }), () => '1').ok,
    false,
  );
  assert.equal(
    executeSaveMemoryNoteTool(JSON.stringify({ title: 'x', content: '  ' }), () => '2').ok,
    false,
  );
  assert.equal(
    executeSaveMemoryNoteTool(
      JSON.stringify({ title: 'x', content: 'y', is_pinned: 'yes' }),
      () => '3',
    ).ok,
    false,
  );
});

test('calculate covers edge cases: deep nesting guard, regex non-match, negative/zero date_diff, json arrays', () => {
  const deepParens = `${'('.repeat(70)}1${')'.repeat(70)}`;
  const tooDeep = executeCalculateTool(JSON.stringify({ expression: deepParens }));
  assert.equal(tooDeep.ok, false);

  const noMatch = executeCalculateTool(
    JSON.stringify({ mode: 'regex_test', pattern: '\\d+', input: 'no digits here' }),
  );
  assert.equal(noMatch.ok, true);
  if (noMatch.ok) {
    assert.deepEqual(noMatch.result, {
      matched: false,
      count: 0,
      matches: [],
      truncated: false,
    });
  }

  const pastDiff = executeCalculateTool(
    JSON.stringify({
      mode: 'date_diff',
      start_date: '2026-05-10T12:00:00Z',
      end_date: '2026-05-10T06:00:00Z',
    }),
  );
  assert.equal(pastDiff.ok, true);
  if (pastDiff.ok) {
    const res = pastDiff.result as { hours: number; direction: string };
    assert.equal(res.hours, -6);
    assert.equal(res.direction, 'past');
  }

  const sameDiff = executeCalculateTool(
    JSON.stringify({
      mode: 'date_diff',
      start_date: '2026-05-10T00:00:00Z',
      end_date: '2026-05-10',
    }),
  );
  assert.equal(sameDiff.ok, true);
  if (sameDiff.ok) {
    const res = sameDiff.result as { milliseconds: number; direction: string };
    assert.equal(res.milliseconds, 0);
    assert.equal(res.direction, 'same');
  }

  const jsonArray = executeCalculateTool(
    JSON.stringify({ mode: 'json_validate', input: '[1, 2, 3]' }),
  );
  assert.equal(jsonArray.ok, true);
  if (jsonArray.ok) {
    const res = jsonArray.result as { valid: boolean; type: string; length: number };
    assert.equal(res.valid, true);
    assert.equal(res.type, 'array');
    assert.equal(res.length, 3);
  }
});

test('edit_file handles CRLF, replace_all, deletion, ambiguous basenames, and mixed-mode rejection', () => {
  const crlfFile = makeFileArtifact({
    id: 'crlf_1',
    filename: 'win.txt',
    content: 'alpha\r\nbeta\r\nalpha\r\n',
  });

  const replacedAll = executeEditFileTool(
    JSON.stringify({
      filename: 'win.txt',
      old_text: 'alpha',
      new_text: 'omega',
      replace_all: true,
    }),
    [crlfFile],
  );
  assert.equal(replacedAll.ok, true);
  if (replacedAll.ok) {
    assert.equal(replacedAll.artifact.content, 'omega\r\nbeta\r\nomega\r\n');
    assert.equal(replacedAll.linesChanged, 2);
  }

  // Delete lines with empty replacement
  const deleted = executeEditFileTool(
    JSON.stringify({
      filename: 'win.txt',
      start_line: 2,
      end_line: 3,
      replacement: '',
    }),
    [crlfFile],
  );
  assert.equal(deleted.ok, true);
  if (deleted.ok) {
    assert.equal(deleted.artifact.content, 'alpha\r\n');
  }

  // Single newline replacement inserts exactly 1 blank line (not 2)
  const singleBlank = executeEditFileTool(
    JSON.stringify({
      filename: 'win.txt',
      start_line: 2,
      end_line: 2,
      replacement: '\n',
    }),
    [crlfFile],
  );
  assert.equal(singleBlank.ok, true);
  if (singleBlank.ok) {
    assert.equal(singleBlank.artifact.content, 'alpha\r\n\r\nalpha\r\n');
  }

  // Ambiguous basename across distinct directories
  const ambiguousFiles = [
    makeFileArtifact({ id: 'a1', filename: 'src/index.ts', content: 'export const a = 1;' }),
    makeFileArtifact({ id: 'a2', filename: 'tests/index.ts', content: 'export const b = 2;' }),
  ];
  const ambiguousLookup = executeEditFileTool(
    JSON.stringify({ filename: 'index.ts', old_text: '1', new_text: '2' }),
    ambiguousFiles,
  );
  assert.equal(ambiguousLookup.ok, false);
  if (!ambiguousLookup.ok) {
    assert.ok(ambiguousLookup.error.includes('ambiguous'));
  }

  // Mixed line-range and exact-text edits rejected
  const mixed = executeEditFileTool(
    JSON.stringify({
      filename: 'win.txt',
      edits: [
        { start_line: 1, replacement: 'x' },
        { old_text: 'beta', new_text: 'gamma' },
      ],
    }),
    [crlfFile],
  );
  assert.equal(mixed.ok, false);
});

test('read_attached_chunk and search_memory handle empty files, bounds, and compact excerpt limits', () => {
  const emptyIndex = buildAttachedFileIndex('empty.txt', '');
  assert.ok(emptyIndex.includes('0 lines, 0 bytes'));

  const emptyRead = executeReadAttachedChunkTool(JSON.stringify({}), [
    { name: 'empty.txt', content: '' },
  ]);
  assert.equal(emptyRead.ok, true);
  if (emptyRead.ok) {
    assert.equal(emptyRead.totalLines, 0);
    assert.equal(emptyRead.linesReturned, 0);
    assert.equal(emptyRead.hasMore, false);
  }

  const outOfRange = executeReadAttachedChunkTool(JSON.stringify({ start_line: 5 }), [
    { name: 'short.txt', content: 'only one line' },
  ]);
  assert.equal(outOfRange.ok, false);

  const longNote = makeMemoryNote({
    id: 'long_pinned',
    title: 'Long Architecture Note',
    content: 'word '.repeat(200),
    isPinned: true,
  });
  const pinnedOnly = executeSearchMemoryTool(
    JSON.stringify({ query: '', pinned_only: true, limit: 0 }),
    [longNote],
  );
  assert.equal(pinnedOnly.ok, true);
  if (pinnedOnly.ok) {
    assert.equal(pinnedOnly.count, 1);
    assert.ok(pinnedOnly.results[0].content.length <= 320);
  }

  const longSaved = executeSaveMemoryNoteTool(
    JSON.stringify({ title: 'Oversized', content: 'x'.repeat(1200), is_pinned: true }),
    () => 'caps1234',
  );
  assert.equal(longSaved.ok, true);
  if (longSaved.ok) {
    assert.ok(longSaved.note.content.length <= 800);
  }
});

test('edit_file recovers malformed local-LLM JSON, parameter aliases, stringified edits, and omitted single filename', () => {
  const file = makeFileArtifact({
    id: 'f_alias',
    filename: 'server.py',
    language: 'python',
    content: 'def start():\n    port = 8000\n    return port\n',
  });

  // 1. Raw unescaped literal newlines inside JSON strings + trailing comma + markdown fence
  const rawMalformed = [
    '```json',
    '{',
    '  "file_path": "./server.py",',
    '  "old_string": "def start():',
    '    port = 8000",',
    '  "new_string": "def start():',
    '    port = 9000",',
    '}',
    '```',
  ].join('\n');
  const res1 = executeEditFileTool(rawMalformed, [file]);
  assert.equal(res1.ok, true, res1.ok ? '' : res1.error);
  if (res1.ok) {
    assert.ok(res1.artifact.content.includes('port = 9000'));
  }

  // 2. Stringified `edits` array + omitted filename with single file + stringified line numbers
  const res2 = executeEditFileTool(
    JSON.stringify({
      edits: JSON.stringify([{ line: '2', replacement: '    port = 3000' }]),
    }),
    [file],
  );
  assert.equal(res2.ok, true, res2.ok ? '' : res2.error);
  if (res2.ok) {
    assert.ok(res2.artifact.content.includes('port = 3000'));
  }

  // 3. Single edit object passed as `edits` with camelCase aliases
  const res3 = executeEditFileTool(
    JSON.stringify({
      file: 'server.py',
      edits: { oldText: 'port = 8000', newText: 'port = 4000' },
    }),
    [file],
  );
  assert.equal(res3.ok, true, res3.ok ? '' : res3.error);
  if (res3.ok) {
    assert.ok(res3.artifact.content.includes('port = 4000'));
  }

  // 4. Full-file content replacement fallback
  const res4 = executeEditFileTool(
    JSON.stringify({ filename: 'server.py', content: 'print("rewritten")\n' }),
    [file],
  );
  assert.equal(res4.ok, true, res4.ok ? '' : res4.error);
  if (res4.ok) {
    assert.equal(res4.artifact.content, 'print("rewritten")\n');
  }
});

test('edit_file strips accidental read_attached_chunk line prefixes, tolerates indentation/trailing-space drift, disambiguates with start_line, and returns closest-line hints on miss', () => {
  const file = makeFileArtifact({
    id: 'f_fuzzy',
    filename: 'game.js',
    language: 'javascript',
    content: [
      'function init() {',
      '    const speed = 1;  ',
      '    return speed;',
      '}',
      '',
      'function reset() {',
      '    const speed = 1;',
      '    return speed;',
      '}',
      '',
    ].join('\n'),
  });

  // 1. Model copied "6: " / "7: " / "8: " line numbers straight from read_attached_chunk
  const prefixed = executeEditFileTool(
    JSON.stringify({
      filename: 'game.js',
      old_text: '6: function reset() {\n7:     const speed = 1;\n8:     return speed;',
      new_text: '6: function reset() {\n7:     const speed = 5;\n8:     return speed;',
    }),
    [file],
  );
  assert.equal(prefixed.ok, true, prefixed.ok ? '' : prefixed.error);
  if (prefixed.ok) {
    assert.equal(prefixed.artifact.content.includes('7: '), false);
    assert.ok(prefixed.artifact.content.includes('function reset() {\n    const speed = 5;'));
  }

  // 2. Line-range replacement with copied "2: " prefix gets cleaned automatically
  const prefixedLineRange = executeEditFileTool(
    JSON.stringify({
      filename: 'game.js',
      start_line: 2,
      end_line: 2,
      replacement: '2:     const speed = 9;',
    }),
    [file],
  );
  assert.equal(prefixedLineRange.ok, true, prefixedLineRange.ok ? '' : prefixedLineRange.error);
  if (prefixedLineRange.ok) {
    assert.equal(prefixedLineRange.artifact.content.includes('2: '), false);
    assert.ok(prefixedLineRange.artifact.content.includes('    const speed = 9;'));
  }

  // 3. Indentation drift (2 spaces instead of 4) matches uniquely & preserves 4-space base indent
  const indentDrift = executeEditFileTool(
    JSON.stringify({
      filename: 'game.js',
      old_text: 'function init() {\n  const speed = 1;\n  return speed;\n}',
      new_text: 'function init() {\n  const speed = 10;\n  return speed;\n}',
    }),
    [file],
  );
  assert.equal(indentDrift.ok, true, indentDrift.ok ? '' : indentDrift.error);
  if (indentDrift.ok) {
    assert.ok(indentDrift.artifact.content.includes('const speed = 10;'));
  }

  // 4. Duplicate old_text disambiguated by start_line hint
  const disambiguated = executeEditFileTool(
    JSON.stringify({
      filename: 'game.js',
      start_line: 7,
      old_text: '    return speed;',
      new_text: '    return speed * 2;',
    }),
    [file],
  );
  assert.equal(disambiguated.ok, true, disambiguated.ok ? '' : disambiguated.error);
  if (disambiguated.ok) {
    assert.ok(disambiguated.artifact.content.includes('function init() {\n    const speed = 1;  \n    return speed;'));
    assert.ok(disambiguated.artifact.content.includes('function reset() {\n    const speed = 1;\n    return speed * 2;'));
  }

  // 5. Append at EOF (start_line === total + 1) and unified diff patch support
  const appended = executeEditFileTool(
    JSON.stringify({
      filename: 'game.js',
      start_line: 10,
      end_line: 10,
      replacement: 'export { init, reset };',
    }),
    [file],
  );
  assert.equal(appended.ok, true, appended.ok ? '' : appended.error);
  if (appended.ok) {
    assert.ok(appended.artifact.content.includes('export { init, reset };'));
  }

  const patched = executeEditFileTool(
    JSON.stringify({
      filename: 'game.js',
      patch: '@@ -6,3 +6,3 @@\n function reset() {\n-    const speed = 1;\n+    const speed = 42;\n     return speed;',
    }),
    [file],
  );
  assert.equal(patched.ok, true, patched.ok ? '' : patched.error);
  if (patched.ok) {
    assert.ok(patched.artifact.content.includes('const speed = 42;'));
  }

  // 6. Miss returns closest matching lines to help the LLM self-correct on Round 2
  const miss = executeEditFileTool(
    JSON.stringify({
      filename: 'game.js',
      old_text: 'function reset() {\n    const speed = 999;\n}',
      new_text: 'function reset() {}',
    }),
    [file],
  );
  assert.equal(miss.ok, false);
  if (!miss.ok) {
    assert.ok(miss.error.includes('Closest lines in file'));
    assert.ok(miss.error.includes('function reset()'));
  }
});
