import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDraftSessionSummary,
  buildSummaryCandidates,
  calculateRecencyScore,
  getPinnedNotesForPrompt,
  retrieveMemoryNotes,
} from '../src/core/memory';
import type { MemoryNote, Session } from '../src/core/types';

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

test('buildSummaryCandidates includes only approved enabled summaries matching session', () => {
  const longContent = 'Discussed architecture constraints and memory packing rules. '.repeat(6);
  const notes: MemoryNote[] = [
    makeNote({
      id: 'sum-approved',
      sessionId: 'sess-1',
      title: 'Session 1 Summary',
      content: longContent,
      sourceReference: '1-4',
      isSummary: true,
      userApproved: true,
    }),
    makeNote({
      id: 'sum-unapproved',
      sessionId: 'sess-1',
      title: 'Draft Summary',
      content: 'Unapproved summary content',
      isSummary: true,
      userApproved: false,
    }),
    makeNote({
      id: 'sum-disabled',
      sessionId: 'sess-1',
      title: 'Disabled Summary',
      content: 'Disabled summary content',
      isSummary: true,
      userApproved: true,
      isDisabled: true,
    }),
    makeNote({
      id: 'sum-other-session',
      sessionId: 'sess-2',
      title: 'Other Session Summary',
      content: 'Should not leak into sess-1',
      isSummary: true,
      userApproved: true,
    }),
    makeNote({
      id: 'regular-note',
      sessionId: 'sess-1',
      title: 'Regular Note',
      content: 'Not a summary',
      isSummary: false,
      userApproved: true,
    }),
  ];

  const candidates = buildSummaryCandidates(notes, 'sess-1');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, 'sum-approved');
  assert.equal(candidates[0].sourceTurnRange, '1-4');
  assert.ok(candidates[0].compactText.length < candidates[0].fullText.length);
});

test('buildDraftSessionSummary creates unapproved summary note from valid session turns', () => {
  const emptySession: Session = {
    id: 'sess-empty',
    title: 'Empty',
    subtitle: 'None',
    createdAt: 1000,
    updatedAt: 1000,
    messages: [],
  };
  assert.equal(buildDraftSessionSummary(emptySession, 'sum-0', 2000), null);

  const session: Session = {
    id: 'sess-active',
    title: 'Budget Architecture',
    subtitle: 'Local',
    createdAt: 1000,
    updatedAt: 2000,
    messages: [
      {
        id: 'm1',
        role: 'user',
        authorName: 'You',
        createdAt: 1100,
        content: 'How should we protect pinned rules?',
        sources: [],
      },
      {
        id: 'm2',
        role: 'assistant',
        authorName: 'LowCon',
        createdAt: 1200,
        content: 'Reserve output space first and pack pinned rules unconditionally.',
        sources: [],
      },
      {
        id: 'm3',
        role: 'assistant',
        authorName: 'LowCon',
        createdAt: 1300,
        content: 'Error occurred',
        sources: [],
        isError: true,
      },
    ],
  };

  const draft = buildDraftSessionSummary(session, 'sum-draft', 3000);
  assert.ok(draft !== null);
  if (draft) {
    assert.equal(draft.isSummary, true);
    assert.equal(draft.userApproved, false);
    assert.equal(draft.sessionId, 'sess-active');
    assert.deepEqual(draft.sourceMessageIds, ['m1', 'm2']);
    assert.ok(draft.content.includes('User: How should we protect pinned rules?'));
    assert.ok(draft.content.includes('Assistant: Reserve output space first'));
  }
});
