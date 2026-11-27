import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Edit3, Eye, EyeOff, FileText, Pin, Plus, Search, Trash2, X } from 'lucide-react';
import { retrieveMemoryNotes } from '../../core/memory';
import { formatRelativeTime } from '../../core/privacy';
import type { MemoryNote } from '../../core/types';

export type MemoryFilter = 'all' | 'pinned' | 'in_prompt' | 'summaries';

interface MemoryViewProps {
  notes: MemoryNote[];
  includedMemoryIds: string[];
  activeSessionId: string;
  canSummarizeActiveSession: boolean;
  requestedFilter?: { filter: MemoryFilter; seq: number } | null;
  onGenerateSessionSummary: () => void;
  onCreateNote: (input: {
    title: string;
    content: string;
    sourceReference: string;
    isPinned: boolean;
    isSummary: boolean;
  }) => void;
  onUpdateNote: (
    noteId: string,
    patch: Partial<Pick<MemoryNote, 'title' | 'content' | 'sourceReference' | 'isPinned' | 'isDisabled' | 'userApproved'>>,
  ) => void;
  onDeleteNote: (noteId: string) => void;
}

export const MemoryView: React.FC<MemoryViewProps> = ({
  notes,
  includedMemoryIds,
  activeSessionId,
  canSummarizeActiveSession,
  requestedFilter,
  onGenerateSessionSummary,
  onCreateNote,
  onUpdateNote,
  onDeleteNote,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<MemoryFilter>('all');

  useEffect(() => {
    if (requestedFilter) {
      setFilter(requestedFilter.filter);
    }
  }, [requestedFilter]);

  // Create Note Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newSource, setNewSource] = useState('Manual local note');
  const [newPinned, setNewPinned] = useState(false);
  const [newIsSummary, setNewIsSummary] = useState(false);

  // Edit Note Modal State (controlled directly so edits persist cleanly — fixes discarded clone bug)
  const [editingNote, setEditingNote] = useState<{
    id: string;
    title: string;
    content: string;
    sourceReference: string;
    isPinned: boolean;
  } | null>(null);

  useEffect(() => {
    if (!showCreateModal && !editingNote) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingNote) setEditingNote(null);
        else if (showCreateModal) setShowCreateModal(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [showCreateModal, editingNote]);

  const includedSet = useMemo(() => new Set(includedMemoryIds), [includedMemoryIds]);

  const isNoteInActivePrompt = useMemo(
    () => (note: MemoryNote) =>
      !note.isDisabled &&
      (includedSet.has(note.id) ||
        (note.isPinned && !note.isSummary && (!note.sessionId || note.sessionId === activeSessionId))),
    [includedSet, activeSessionId],
  );

  const filteredNotes = useMemo(() => {
    // Runs BM25 FTS over ALL notes in the library (no session hiding or 50-item cap)
    const scored = retrieveMemoryNotes(notes, {
      query: searchQuery.trim() || undefined,
      includeDisabled: true,
      limit: notes.length,
    });

    return scored
      .map((s) => ({ note: s.note, score: s.finalScore }))
      .filter(({ note }) => {
        if (filter === 'pinned') return note.isPinned;
        if (filter === 'in_prompt') return isNoteInActivePrompt(note);
        if (filter === 'summaries') return note.isSummary;
        return true;
      });
  }, [notes, searchQuery, filter, isNoteInActivePrompt]);

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;
    onCreateNote({
      title: newTitle.trim(),
      content: newContent.trim(),
      sourceReference: newSource.trim() || (newIsSummary ? '1-4' : 'Manual local note'),
      isPinned: newPinned,
      isSummary: newIsSummary,
    });
    setNewTitle('');
    setNewContent('');
    setNewSource('Manual local note');
    setNewPinned(false);
    setNewIsSummary(false);
    setShowCreateModal(false);
    if (newIsSummary) {
      setFilter('summaries');
    }
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingNote || !editingNote.title.trim() || !editingNote.content.trim()) return;
    onUpdateNote(editingNote.id, {
      title: editingNote.title.trim(),
      content: editingNote.content.trim(),
      sourceReference: editingNote.sourceReference.trim() || 'Manual local note',
      isPinned: editingNote.isPinned,
    });
    setEditingNote(null);
  };

  const filterChips: Array<{ id: MemoryFilter; label: string }> = [
    { id: 'all', label: `All (${notes.length})` },
    { id: 'pinned', label: `Pinned (${notes.filter((n) => n.isPinned).length})` },
    {
      id: 'in_prompt',
      label: `In Active Prompt (${notes.filter(isNoteInActivePrompt).length})`,
    },
    { id: 'summaries', label: `Summaries (${notes.filter((n) => n.isSummary).length})` },
  ];

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--lc-bg)] text-[var(--lc-ink)]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--lc-line)] px-7 py-3">
        <div className="flex items-center text-[13px]">
          <span className="text-[var(--lc-mute)]">Workspace /</span>
          <span className="ml-1 font-semibold text-[var(--lc-ink)]">Memory</span>
        </div>

        <div className="flex items-center gap-2">
          {canSummarizeActiveSession && (
            <button
              type="button"
              onClick={() => {
                onGenerateSessionSummary();
                setFilter('summaries');
              }}
              className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--lc-surf-ink)] hover:bg-[var(--lc-surf-hover)]"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>Summarize Active Chat</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-[var(--lc-accent)] px-3.5 py-1.5 text-[12.5px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New Note</span>
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[820px] space-y-5">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight text-[var(--lc-ink)]">
              Local Memory & Pinned Project Rules
            </h1>
            <p className="mt-1 text-[13.5px] text-[var(--lc-ink2)]">
              Pinned rules are injected unconditionally into every prompt regardless of wording.
              Unpinned notes are retrieved across your entire library using BM25 + recency scoring.
            </p>
          </div>

          {/* Search & Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[var(--lc-surf-mute)]" />
              <label htmlFor="memory-search-input" className="sr-only">
                Search memory notes
              </label>
              <input
                id="memory-search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search across all local memory notes (BM25 full-text)..."
                className="w-full rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] py-2 pr-3 pl-9 text-[13.5px] text-[var(--lc-surf-ink)] placeholder:text-[var(--lc-surf-mute)] focus:border-[var(--lc-accent)] focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {filterChips.map((chip) => {
                const active = filter === chip.id;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setFilter(chip.id)}
                    className={`rounded-[6px] px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                      active
                        ? 'bg-[var(--lc-active-pill-bg)] text-[var(--lc-active-pill-fg)]'
                        : 'border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]'
                    }`}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Notes List */}
          <div className="space-y-3">
            {filteredNotes.length === 0 ? (
              <div className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-5 py-8 text-center text-[13.5px] text-[var(--lc-surf-mute)]">
                No memory notes match the current filter or search query.
              </div>
            ) : (
              filteredNotes.map(({ note }) => {
                const isInPrompt = isNoteInActivePrompt(note);
                return (
                  <article
                    key={note.id}
                    data-testid={`memory-note-${note.id}`}
                    className={`rounded-[8px] border bg-[var(--lc-surface)] p-4 text-[var(--lc-surf-ink)] ${
                      note.isDisabled
                        ? 'border-[var(--lc-surf-line)] opacity-60'
                        : note.isPinned
                          ? 'border-[var(--lc-accent)]'
                          : 'border-[var(--lc-surf-line)]'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-[14.5px] font-bold text-[var(--lc-surf-ink)]">{note.title}</h2>
                          {note.isPinned && (
                            <span className="rounded-[4px] bg-[var(--lc-surf-active-bg)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--lc-surf-active-fg)]">
                              PINNED RULE
                            </span>
                          )}
                          {isInPrompt && (
                            <span className="rounded-[4px] bg-[var(--lc-accent)]/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--lc-accent)]">
                              IN ACTIVE PROMPT
                            </span>
                          )}
                          {note.isSummary && (
                            <span className="rounded-[4px] bg-[var(--lc-surf-hover)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--lc-surf-ink2)]">
                              {note.userApproved ? 'APPROVED SUMMARY' : 'UNAPPROVED SUMMARY'}
                            </span>
                          )}
                          {note.isDisabled && (
                            <span className="rounded-[4px] bg-[var(--lc-surf-hover)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--lc-surf-mute)]">
                              DISABLED
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-[var(--lc-surf-ink2)]">
                          {note.content}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-x-3 text-[11.5px] text-[var(--lc-surf-mute)]">
                          <span>Source: {note.sourceReference}</span>
                          <span>Updated {formatRelativeTime(note.updatedAt)}</span>
                        </div>
                      </div>

                      {/* Note Actions */}
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        {note.isSummary && !note.userApproved && (
                          <button
                            type="button"
                            onClick={() => onUpdateNote(note.id, { userApproved: true })}
                            aria-label={`Approve summary ${note.title}`}
                            className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--lc-success)] bg-[var(--lc-success)]/10 px-2.5 py-1 text-[12px] font-semibold text-[var(--lc-success)] hover:bg-[var(--lc-success)]/20"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Approve</span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => onUpdateNote(note.id, { isPinned: !note.isPinned })}
                          aria-label={`${note.isPinned ? 'Unpin' : 'Pin'} ${note.title}`}
                          className={`inline-flex items-center gap-1 rounded-[6px] border px-2.5 py-1 text-[12px] font-medium ${
                            note.isPinned
                              ? 'border-[var(--lc-accent)] bg-[var(--lc-accent)] text-[var(--lc-accent-contrast)]'
                              : 'border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]'
                          }`}
                        >
                          <Pin className="h-3 w-3" />
                          <span>{note.isPinned ? 'Pinned' : 'Pin'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onUpdateNote(note.id, { isDisabled: !note.isDisabled })}
                          aria-label={`${note.isDisabled ? 'Enable' : 'Disable'} ${note.title}`}
                          className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1 text-[12px] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]"
                        >
                          {note.isDisabled ? (
                            <Eye className="h-3 w-3" />
                          ) : (
                            <EyeOff className="h-3 w-3" />
                          )}
                          <span>{note.isDisabled ? 'Enable' : 'Disable'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setEditingNote({
                              id: note.id,
                              title: note.title,
                              content: note.content,
                              sourceReference: note.sourceReference,
                              isPinned: note.isPinned,
                            })
                          }
                          aria-label={`Edit ${note.title}`}
                          className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1 text-[12px] font-medium text-[var(--lc-surf-ink)] hover:bg-[var(--lc-surf-hover)]"
                        >
                          <Edit3 className="h-3 w-3" />
                          <span>Edit</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onDeleteNote(note.id)}
                          aria-label={`Delete ${note.title}`}
                          className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2 py-1 text-[12px] text-[var(--lc-surf-mute)] hover:border-[var(--lc-danger)] hover:text-[var(--lc-danger)]"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Create Note Modal */}
      {showCreateModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-note-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowCreateModal(false);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
        >
          <form
            onSubmit={handleCreateSubmit}
            className="w-full max-w-[520px] rounded-[10px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink)] shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--lc-surf-line)] px-5 py-3.5">
              <h2 id="create-note-title" className="text-[15px] font-bold text-[var(--lc-surf-ink)]">
                Create Memory Note
              </h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                aria-label="Close create note dialog"
                className="rounded p-1 text-[var(--lc-surf-mute)] hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3.5 px-5 py-4">
              <div>
                <label htmlFor="create-note-title-input" className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]">
                  Title
                </label>
                <input
                  id="create-note-title-input"
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Strict TypeScript output format"
                  className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[13.5px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="create-note-content-input" className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]">
                  Content
                </label>
                <textarea
                  id="create-note-content-input"
                  required
                  rows={4}
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Write concise, factual constraints or project decisions..."
                  className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-2 text-[13.5px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="create-note-source-input" className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]">
                  Source Reference
                </label>
                <input
                  id="create-note-source-input"
                  type="text"
                  value={newSource}
                  onChange={(e) => setNewSource(e.target.value)}
                  className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[13px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                />
              </div>
              <label className="flex items-center gap-2 text-[13px] text-[var(--lc-surf-ink)]">
                <input
                  type="checkbox"
                  checked={newPinned}
                  onChange={(e) => setNewPinned(e.target.checked)}
                  className="h-4 w-4 accent-[var(--lc-accent)]"
                />
                <span>Pin as project rule (always included in every prompt)</span>
              </label>
              <label className="flex items-center gap-2 text-[13px] text-[var(--lc-surf-ink)]">
                <input
                  type="checkbox"
                  checked={newIsSummary}
                  onChange={(e) => setNewIsSummary(e.target.checked)}
                  className="h-4 w-4 accent-[var(--lc-accent)]"
                />
                <span>Create as conversation summary (requires approval before prompt injection)</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--lc-surf-line)] px-5 py-3">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3.5 py-1.5 text-[13px] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-[6px] bg-[var(--lc-accent)] px-4 py-1.5 text-[13px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)]"
              >
                Save Note
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit Note Modal (Controlled live state — fixes silent discard bug) */}
      {editingNote && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-note-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditingNote(null);
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
        >
          <form
            onSubmit={handleEditSubmit}
            className="w-full max-w-[520px] rounded-[10px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink)] shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--lc-surf-line)] px-5 py-3.5">
              <h2 id="edit-note-title" className="text-[15px] font-bold text-[var(--lc-surf-ink)]">
                Edit Memory Note
              </h2>
              <button
                type="button"
                onClick={() => setEditingNote(null)}
                aria-label="Close edit note dialog"
                className="rounded p-1 text-[var(--lc-surf-mute)] hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3.5 px-5 py-4">
              <div>
                <label htmlFor="edit-note-title-input" className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]">
                  Title
                </label>
                <input
                  id="edit-note-title-input"
                  type="text"
                  required
                  value={editingNote.title}
                  onChange={(e) =>
                    setEditingNote((prev) => (prev ? { ...prev, title: e.target.value } : null))
                  }
                  className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[13.5px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="edit-note-content-input" className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]">
                  Content
                </label>
                <textarea
                  id="edit-note-content-input"
                  required
                  rows={4}
                  value={editingNote.content}
                  onChange={(e) =>
                    setEditingNote((prev) => (prev ? { ...prev, content: e.target.value } : null))
                  }
                  className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-2 text-[13.5px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="edit-note-source-input" className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]">
                  Source Reference
                </label>
                <input
                  id="edit-note-source-input"
                  type="text"
                  value={editingNote.sourceReference}
                  onChange={(e) =>
                    setEditingNote((prev) =>
                      prev ? { ...prev, sourceReference: e.target.value } : null,
                    )
                  }
                  className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[13px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                />
              </div>
              <label className="flex items-center gap-2 text-[13px] text-[var(--lc-surf-ink)]">
                <input
                  type="checkbox"
                  checked={editingNote.isPinned}
                  onChange={(e) =>
                    setEditingNote((prev) => (prev ? { ...prev, isPinned: e.target.checked } : null))
                  }
                  className="h-4 w-4 accent-[var(--lc-accent)]"
                />
                <span>Pin as project rule (always included in every prompt)</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-[var(--lc-surf-line)] px-5 py-3">
              <button
                type="button"
                onClick={() => setEditingNote(null)}
                className="rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3.5 py-1.5 text-[13px] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-[6px] bg-[var(--lc-accent)] px-4 py-1.5 text-[13px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)]"
              >
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
