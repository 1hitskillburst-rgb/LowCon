import React, { useEffect, useState } from 'react';
import { getFreeTokens, getPackedPercentage, getPackedTokens } from '../../core/context';
import { formatNumber } from '../../core/privacy';
import type { ContextSegmentKey, MemoryNote, TurnContextBudget } from '../../core/types';
import { ContextSegmentRow, VerticalContextStack } from './ContextBudgetViz';

interface ContextPanelProps {
  embedded?: boolean;
  budget: TurnContextBudget;
  previewWarning?: string | null;
  taskGoal?: string;
  onUpdateTaskGoal: (goal: string) => void;
  memoryNotes: MemoryNote[];
  includedMemoryIds: string[];
  memoryRetrievalEnabled: boolean;
  onToggleMemoryRetrieval: (enabled: boolean) => void;
  hoveredSegment: ContextSegmentKey | null;
  onHoverSegment: (key: ContextSegmentKey | null) => void;
  onOpenPromptInspector: () => void;
}

export const ContextPanel: React.FC<ContextPanelProps> = ({
  embedded = false,
  budget,
  previewWarning,
  taskGoal,
  onUpdateTaskGoal,
  memoryNotes,
  includedMemoryIds,
  memoryRetrievalEnabled,
  onToggleMemoryRetrieval,
  hoveredSegment,
  onHoverSegment,
  onOpenPromptInspector,
}) => {
  const [isEditingGoal, setIsEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState(taskGoal ?? '');

  useEffect(() => {
    setIsEditingGoal(false);
    setGoalDraft(taskGoal ?? '');
  }, [taskGoal]);

  const packed = getPackedTokens(budget);
  const free = getFreeTokens(budget);
  const pct = getPackedPercentage(budget);
  const limitLabel =
    budget.totalLimit >= 1024
      ? `${(budget.totalLimit / 1024).toFixed(budget.totalLimit % 1024 === 0 ? 0 : 1)}K model`
      : `${budget.totalLimit} tok`;

  const includedSet = new Set(includedMemoryIds);
  const activeNotesInPrompt = memoryNotes.filter(
    (n) => !n.isDisabled && (includedSet.has(n.id) || (n.isPinned && !n.isSummary)),
  );

  const content = (
    <>
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold text-[var(--lc-side-ink)]">Context window</h2>
        <span className="text-[12.5px] text-[var(--lc-side-mute)]">{limitLabel}</span>
      </div>

      {/* Big Total Tokens Packed */}
      <div className="mt-3.5 flex flex-wrap items-baseline gap-1.5">
        <span
          data-testid="context-packed-tokens"
          className="text-[32px] leading-none font-bold tracking-tight text-[var(--lc-side-ink)] tabular-nums"
        >
          {formatNumber(packed)}
        </span>
        <span className="text-[13px] text-[var(--lc-side-mute)]">
          of {formatNumber(budget.totalLimit)} tokens packed · {Math.round(pct)}%
        </span>
      </div>

      <p className="mt-1.5 text-[13px] text-[var(--lc-side-ink2)]">
        {formatNumber(free)} still free for more history or memory.
      </p>

      {previewWarning && (
        <div
          role="alert"
          className="mt-2.5 rounded-[6px] border border-[var(--lc-danger)]/40 bg-[var(--lc-danger)]/10 px-2.5 py-2 text-[12px] leading-snug text-[var(--lc-danger)]"
        >
          {previewWarning}
        </div>
      )}

      {/* Dual 44px Vertical Stack + Row Breakdown */}
      <div className="mt-4 flex items-start gap-3">
        <VerticalContextStack
          budget={budget}
          hoveredKey={hoveredSegment}
          onHoverChange={onHoverSegment}
        />
        <div className="min-w-0 flex-1">
          {budget.segments.map((seg) => (
            <ContextSegmentRow
              key={`${seg.key}-${seg.name}`}
              segment={seg}
              isHovered={hoveredSegment === seg.key}
              onHoverChange={onHoverSegment}
            />
          ))}
        </div>
      </div>

      {/* Inspect Exact Prompt Button */}
      <button
        type="button"
        onClick={onOpenPromptInspector}
        className="mt-4 h-[38px] w-full rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[13.5px] font-semibold text-[var(--lc-surf-ink)] transition-colors hover:bg-[var(--lc-surf-hover)]"
      >
        Inspect exact prompt
      </button>

      {/* Active Session Task Goal */}
      <div className="mt-6 border-t border-[var(--lc-line)] pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[14px] font-bold text-[var(--lc-side-ink)]">Active task goal</h3>
          {!isEditingGoal && (
            <div className="flex items-center gap-2">
              {taskGoal?.trim() && (
                <button
                  type="button"
                  onClick={() => onUpdateTaskGoal('')}
                  className="text-[11.5px] font-medium text-[var(--lc-side-mute)] hover:text-[var(--lc-danger)]"
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setGoalDraft(taskGoal ?? '');
                  setIsEditingGoal(true);
                }}
                className="text-[12px] font-semibold text-[var(--lc-accent)] hover:underline"
              >
                {taskGoal?.trim() ? 'Edit' : 'Set goal'}
              </button>
            </div>
          )}
        </div>

        {isEditingGoal ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onUpdateTaskGoal(goalDraft);
              setIsEditingGoal(false);
            }}
            className="mt-2 space-y-2"
          >
            <label htmlFor="session-task-goal-input" className="sr-only">
              Active session task goal
            </label>
            <textarea
              id="session-task-goal-input"
              rows={2}
              value={goalDraft}
              onChange={(e) => setGoalDraft(e.target.value)}
              placeholder="e.g. Keep answers under 150 words and cite local files only"
              className="w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1.5 text-[12.5px] text-[var(--lc-surf-ink)] placeholder:text-[var(--lc-surf-mute)] focus:border-[var(--lc-accent)] focus:outline-none"
            />
            <div className="flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setGoalDraft(taskGoal ?? '');
                  setIsEditingGoal(false);
                }}
                className="rounded-[5px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-[5px] bg-[var(--lc-accent)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)]"
              >
                Save goal
              </button>
            </div>
          </form>
        ) : taskGoal?.trim() ? (
          <p
            data-testid="active-task-goal-display"
            className="mt-1.5 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-2 text-[12.5px] leading-snug text-[var(--lc-surf-ink)]"
          >
            {taskGoal}
          </p>
        ) : (
          <p className="mt-1.5 text-[12.5px] italic text-[var(--lc-side-mute)]">
            No task goal set for this session.
          </p>
        )}
      </div>

      {/* Memory in this prompt */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-bold text-[var(--lc-side-ink)]">Memory in this prompt</h3>
          <span className="text-[12px] text-[var(--lc-side-mute)]">
            {activeNotesInPrompt.length} of {memoryNotes.length} notes
          </span>
        </div>

        <div className="mt-2.5 space-y-2.5">
          {activeNotesInPrompt.length === 0 ? (
            <p className="text-[12.5px] italic text-[var(--lc-side-mute)]">
              No memory excerpts injected for this prompt.
            </p>
          ) : (
            activeNotesInPrompt.map((note) => (
              <div
                key={note.id}
                className="border-l-[3px] pl-3"
                style={{ borderColor: note.isPinned ? 'var(--lc-side-ink)' : 'var(--lc-seg-mem)' }}
              >
                <div className="text-[11.5px] text-[var(--lc-side-mute)]">
                  {note.isSummary
                    ? 'Approved history summary'
                    : note.isPinned
                      ? 'Pinned project rule (always included)'
                      : 'Retrieved as relevant'}
                </div>
                <div className="text-[13px] font-medium text-[var(--lc-side-ink)]">{note.title}</div>
                <div className="line-clamp-2 text-[12px] text-[var(--lc-side-ink2)]">{note.content}</div>
                <div className="mt-0.5 text-[11px] text-[var(--lc-side-mute)]">{note.sourceReference}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Memory Retrieval Toggle */}
      <div className="mt-5 flex items-center justify-between border-t border-[var(--lc-line)] pt-4">
        <span className="text-[13px] text-[var(--lc-side-ink2)]">Memory retrieval</span>
        <button
          type="button"
          role="switch"
          aria-checked={memoryRetrievalEnabled}
          aria-label="Toggle automatic memory retrieval"
          onClick={() => onToggleMemoryRetrieval(!memoryRetrievalEnabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            memoryRetrievalEnabled ? 'bg-[var(--lc-accent)]' : 'bg-[var(--lc-seg-tpl)]'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              memoryRetrievalEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </button>
      </div>
    </>
  );

  if (embedded) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-4 pb-7 text-[var(--lc-side-ink)]">
        {content}
      </div>
    );
  }

  return (
    <aside
      aria-label="Context window and active memory"
      className="flex h-full w-[344px] shrink-0 flex-col overflow-y-auto border-l border-[var(--lc-line)] bg-[var(--lc-panel)] px-[22px] pt-[22px] pb-7 text-[var(--lc-side-ink)]"
    >
      {content}
    </aside>
  );
};
