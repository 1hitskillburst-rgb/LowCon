import React, { useMemo, useState } from 'react';
import { CheckCircle2, Edit3, Eye, EyeOff, Pin, Plus, Search, Trash2, X } from 'lucide-react';
import { retrieveMemoryNotes } from '../core/memory';
import { formatRelativeTime } from '../core/privacy';
import type { MemoryNote } from '../core/types';

type MemoryFilter = 'all' | 'pinned' | 'in_prompt' | 'summaries';

interface MemoryViewProps {
  notes: MemoryNote[];
  includedMemoryIds: string[];
  activeSessionId: string;
  onCreateNote: (input: {
    title: string;
    content: string;
    sourceReference: string;
    isPinned: boolean;
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
  onCreateNote,
  onUpdateNote,
  onDeleteNote,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<MemoryFilter>('all');

  // Create Note Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newSource, setNewSource] = useState('Manual local note');
  const [newPinned, setNewPinned] = useState(false);

  // Edit Note Modal State (controlled directly so edits persist cleanly — fixes discarded clone bug)
  const [editingNote, setEditingNote] = useState<{
    id: string;
    title: string;
    content: string;
    sourceReference: string;
    isPinned: boolean;
  } | null>(null);

  const includedSet = useMemo(() => new Set(includedMemoryIds), [includedMemoryIds]);

  const filteredNotes = useMemo(() => {
    // Runs BM25 FTS over ALL notes (no arbitrary 50-item truncation)
    const scored = retrieveMemoryNotes(notes, {
      query: searchQuery.trim() || undefined,
      sessionId: activeSessionId,
      includeDisabled: true,
      limit: notes.length,
    });

    return scored
      .map((s) => ({ note: s.note, score: s.finalScore }))
      .filter(({ note }) => {
        if (filter === 'pinned') return note.isPinned;
        if (filter === 'in_prompt') return !note.isDisabled && (includedSet.has(note.id) || note.isPinned);
        if (filter === 'summaries') return note.isSummary;
        return true;
      });
  }, [notes, searchQuery, activeSessionId, filter, includedSet]);

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;
    onCreateNote({
      title: newTitle.trim(),
      content: newContent.trim(),
      sourceReference: newSource.trim() || 'Manual local note',
      isPinned: newPinned,
    });
    setNewTitle('');
    setNewContent('');
    setNewSource('Manual local note');
    setNewPinned(false);
    setShowCreateModal(false);
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
      label: `In Active Prompt (${notes.filter((n) => !n.isDisabled && (includedSet.has(n.id) || n.isPinned)).length})`,
    },
    { id: 'summaries', label: `Summaries (${notes.filter((n) => n.isSummary).length})` },
  ];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[#F7F8F9]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-[#D3D8DF] px-7 py-3">
        <div className="flex items-center text-[13px]">
          <span className="text-[#778091]">Workspace /</span>
          <span className="ml-1 font-semibold text-[#161B26]">Memory</span>
        </div>

        <button
          type="button"
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-1.5 rounded-[6px] bg-[#2A3FE0] px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-[#2234be]"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New Note</span>
        </button>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[820px] space-y-5">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight text-[#161B26]">
              Local Memory & Pinned Project Rules
            </h1>
            <p className="mt-1 text-[13.5px] text-[#444D5C]">
              Pinned rules are injected unconditionally into every prompt regardless of wording.
              Unpinned notes are retrieved across your entire library using BM25 + recency scoring.
            </p>
          </div>

          {/* Search & Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[#778091]" />
              <label htmlFor="memory-search-input" className="sr-only">
                Search memory notes
              </label>
              <input
                id="memory-search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search across all local memory notes (BM25 full-text)..."
                className="w-full rounded-[8px] border border-[#D3D8DF] bg-white py-2 pr-3 pl-9 text-[13.5px] text-[#161B26] placeholder:text-[#778091] focus:border-[#2A3FE0] focus:outline-none"
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
                        ? 'bg-[#161B26] text-white'
                        : 'border border-[#D3D8DF] bg-white text-[#444D5C] hover:bg-[#DDE1E7]'
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
              <div className="rounded-[8px] border border-[#D3D8DF] bg-white px-5 py-8 text-center text-[13.5px] text-[#778091]">
                No memory notes match the current filter or search query.
              </div>
            ) : (
              filteredNotes.map(({ note }) => {
                const isInPrompt = !note.isDisabled && (includedSet.has(note.id) || note.isPinned);
                return (
                  <article
                    key={note.id}
                    data-testid={`memory-note-${note.id}`}
                    className={`rounded-[8px] border bg-white p-4 ${
                      note.isDisabled
                        ? 'border-[#D3D8DF] opacity-60'
                        : note.isPinned
                          ? 'border-[#161B26]'
                          : 'border-[#D3D8DF]'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-[14.5px] font-bold text-[#161B26]">{note.title}</h2>
                          {note.isPinned && (
                            <span className="rounded-[4px] bg-[#161B26] px-1.5 py-0.5 text-[10.5px] font-semibold text-white">
                              PINNED RULE
                            </span>
                          )}
                          {isInPrompt && (
                            <span className="rounded-[4px] bg-[#2A3FE0]/12 px-1.5 py-0.5 text-[10.5px] font-semibold text-[#2A3FE0]">
                              IN ACTIVE PROMPT
                            </span>
                          )}
                          {note.isSummary && (
                            <span className="rounded-[4px] bg-[#EEF0F3] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#444D5C]">
                              {note.userApproved ? 'APPROVED SUMMARY' : 'UNAPPROVED SUMMARY'}
                            </span>
                          )}
                          {note.isDisabled && (
                            <span className="rounded-[4px] bg-[#E8EBEF] px-1.5 py-0.5 text-[10.5px] font-semibold text-[#778091]">
                              DISABLED
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-[#1D2330]">
                          {note.content}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-x-3 text-[11.5px] text-[#778091]">
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
                            className="inline-flex items-center gap-1 rounded-[6px] border border-[#1D7A4E] bg-[#1D7A4E]/10 px-2.5 py-1 text-[12px] font-semibold text-[#1D7A4E] hover:bg-[#1D7A4E]/20"
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
                              ? 'border-[#161B26] bg-[#161B26] text-white'
                              : 'border-[#D3D8DF] bg-white text-[#444D5C] hover:bg-[#DDE1E7]'
                          }`}
                        >
                          <Pin className="h-3 w-3" />
                          <span>{note.isPinned ? 'Pinned' : 'Pin'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onUpdateNote(note.id, { isDisabled: !note.isDisabled })}
                          aria-label={`${note.isDisabled ? 'Enable' : 'Disable'} ${note.title}`}
                          className="inline-flex items-center gap-1 rounded-[6px] border border-[#D3D8DF] bg-white px-2.5 py-1 text-[12px] text-[#444D5C] hover:bg-[#DDE1E7]"
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
                          className="inline-flex items-center gap-1 rounded-[6px] border border-[#D3D8DF] bg-white px-2.5 py-1 text-[12px] font-medium text-[#161B26] hover:bg-[#DDE1E7]"
                        >
                          <Edit3 className="h-3 w-3" />
                          <span>Edit</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onDeleteNote(note.id)}
                          aria-label={`Delete ${note.title}`}
                          className="inline-flex items-center gap-1 rounded-[6px] border border-[#D3D8DF] bg-white px-2 py-1 text-[12px] text-[#778091] hover:border-[#D9383A] hover:text-[#D9383A]"
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
        >
          <form
            onSubmit={handleCreateSubmit}
            className="w-full max-w-[520px] rounded-[10px] border border-[#D3D8DF] bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-[#D3D8DF] px-5 py-3.5">
              <h2 id="create-note-title" className="text-[15px] font-bold text-[#161B26]">
                Create Memory Note
              </h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                aria-label="Close create note dialog"
                className="rounded p-1 text-[#778091] hover:bg-[#E8EBEF] hover:text-[#161B26]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3.5 px-5 py-4">
              <div>
                <label htmlFor="create-note-title-input" className="block text-[12px] font-semibold text-[#444D5C]">
                  Title
                </label>
                <input
                  id="create-note-title-input"
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="e.g. Strict TypeScript output format"
                  className="mt-1 w-full rounded-[6px] border border-[#D3D8DF] px-3 py-1.5 text-[13.5px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="create-note-content-input" className="block text-[12px] font-semibold text-[#444D5C]">
                  Content
                </label>
                <textarea
                  id="create-note-content-input"
                  required
                  rows={4}
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="Write concise, factual constraints or project decisions..."
                  className="mt-1 w-full rounded-[6px] border border-[#D3D8DF] px-3 py-2 text-[13.5px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="create-note-source-input" className="block text-[12px] font-semibold text-[#444D5C]">
                  Source Reference
                </label>
                <input
                  id="create-note-source-input"
                  type="text"
                  value={newSource}
                  onChange={(e) => setNewSource(e.target.value)}
                  className="mt-1 w-full rounded-[6px] border border-[#D3D8DF] px-3 py-1.5 text-[13px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
                />
              </div>
              <label className="flex items-center gap-2 text-[13px] text-[#161B26]">
                <input
                  type="checkbox"
                  checked={newPinned}
                  onChange={(e) => setNewPinned(e.target.checked)}
                  className="h-4 w-4 accent-[#2A3FE0]"
                />
                <span>Pin as project rule (always included in every prompt)</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-[#D3D8DF] px-5 py-3">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="rounded-[6px] border border-[#D3D8DF] bg-white px-3.5 py-1.5 text-[13px] text-[#444D5C] hover:bg-[#E8EBEF]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-[6px] bg-[#2A3FE0] px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-[#2234be]"
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
        >
          <form
            onSubmit={handleEditSubmit}
            className="w-full max-w-[520px] rounded-[10px] border border-[#D3D8DF] bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-[#D3D8DF] px-5 py-3.5">
              <h2 id="edit-note-title" className="text-[15px] font-bold text-[#161B26]">
                Edit Memory Note
              </h2>
              <button
                type="button"
                onClick={() => setEditingNote(null)}
                aria-label="Close edit note dialog"
                className="rounded p-1 text-[#778091] hover:bg-[#E8EBEF] hover:text-[#161B26]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3.5 px-5 py-4">
              <div>
                <label htmlFor="edit-note-title-input" className="block text-[12px] font-semibold text-[#444D5C]">
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
                  className="mt-1 w-full rounded-[6px] border border-[#D3D8DF] px-3 py-1.5 text-[13.5px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="edit-note-content-input" className="block text-[12px] font-semibold text-[#444D5C]">
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
                  className="mt-1 w-full rounded-[6px] border border-[#D3D8DF] px-3 py-2 text-[13.5px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="edit-note-source-input" className="block text-[12px] font-semibold text-[#444D5C]">
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
                  className="mt-1 w-full rounded-[6px] border border-[#D3D8DF] px-3 py-1.5 text-[13px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
                />
              </div>
              <label className="flex items-center gap-2 text-[13px] text-[#161B26]">
                <input
                  type="checkbox"
                  checked={editingNote.isPinned}
                  onChange={(e) =>
                    setEditingNote((prev) => (prev ? { ...prev, isPinned: e.target.checked } : null))
                  }
                  className="h-4 w-4 accent-[#2A3FE0]"
                />
                <span>Pin as project rule (always included in every prompt)</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-[#D3D8DF] px-5 py-3">
              <button
                type="button"
                onClick={() => setEditingNote(null)}
                className="rounded-[6px] border border-[#D3D8DF] bg-white px-3.5 py-1.5 text-[13px] text-[#444D5C] hover:bg-[#E8EBEF]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-[6px] bg-[#2A3FE0] px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-[#2234be]"
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
