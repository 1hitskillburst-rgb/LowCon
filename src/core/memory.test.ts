import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateRecencyScore,
  getPinnedNotesForPrompt,
  retrieveMemoryNotes,
} from './memory';
import type { MemoryNote } from './types';

function makeNote(overrides: Partial<MemoryNote>): MemoryNote {
  const now = 1_700_000_000_000;
  return {
    id: overrides.id ?? 'n1',
    sessionId: overrides.sessionId,
    title: overrides.title ?? 'Default title',
    content: overrides.content ?? 'Default content',
    sourceReference: overrides.sourceReference ?? 'Manual note',
    sourceMessageIds: [],
    isPinned: overrides.isPinned ?? false,
    isSummary: overrides.isSummary ?? false,
    isDisabled: overrides.isDisabled ?? false,
    userApproved: overrides.userApproved ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  };
}

test('recency score decays by 0.5 per half-life', () => {
  const now = 1_700_000_000_000;
  const oneDayMs = 86_400_000;
  assert.ok(Math.abs(calculateRecencyScore(now, now, 86400) - 1.0) < 1e-6);
  assert.ok(Math.abs(calculateRecencyScore(now - oneDayMs, now, 86400) - 0.5) < 1e-6);
  assert.ok(Math.abs(calculateRecencyScore(now - 2 * oneDayMs, now, 86400) - 0.25) < 1e-6);
});

test('pinned notes are always returned for prompt packing even with unrelated user query', () => {
  const pinned = makeNote({
    id: 'pin-rule',
    title: 'Output Formatting Rule',
    content: 'Always answer with bullet points.',
    isPinned: true,
  });
  const unpinned = makeNote({
    id: 'normal-note',
    title: 'Rust Ownership',
    content: 'Borrow checker enforces memory safety.',
    isPinned: false,
  });

  const pinnedList = getPinnedNotesForPrompt([pinned, unpinned], 'sess-1');
  assert.equal(pinnedList.length, 1);
  assert.equal(pinnedList[0].id, 'pin-rule');

  // Unrelated lexical query returns no unpinned notes, while pinnedList still guarantees injection
  const retrieved = retrieveMemoryNotes([pinned, unpinned], {
    query: 'hello completely unrelated message',
    sessionId: 'sess-1',
    excludePinned: true,
  });
  assert.equal(retrieved.length, 0);
});

test('full-text search indexes beyond 50 notes and enforces summary approval gating', () => {
  const notes: MemoryNote[] = [];
  for (let i = 0; i < 75; i++) {
    notes.push(
      makeNote({
        id: `note-${i}`,
        title: `Entry ${i}`,
        content: i === 72 ? 'Unique needle keyword quantum_budget_token' : 'Ordinary filler text',
      }),
    );
  }
  notes.push(
    makeNote({
      id: 'unapproved-summary',
      title: 'Draft Summary',
      content: 'Unique needle keyword quantum_budget_token',
      isSummary: true,
      userApproved: false,
    }),
  );

  const hits = retrieveMemoryNotes(notes, {
    query: 'quantum_budget_token',
    requireApproved: true,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].note.id, 'note-72');
});
