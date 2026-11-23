import React from 'react';
import { getFreeTokens, getPackedPercentage, getPackedTokens } from '../core/context';
import { formatNumber } from '../core/privacy';
import type { ContextSegmentKey, MemoryNote, TurnContextBudget } from '../core/types';
import { ContextSegmentRow, VerticalContextStack } from './ContextBudgetViz';

interface ContextPanelProps {
  budget: TurnContextBudget;
  memoryNotes: MemoryNote[];
  includedMemoryIds: string[];
  memoryRetrievalEnabled: boolean;
  onToggleMemoryRetrieval: (enabled: boolean) => void;
  hoveredSegment: ContextSegmentKey | null;
  onHoverSegment: (key: ContextSegmentKey | null) => void;
  onOpenPromptInspector: () => void;
}

export const ContextPanel: React.FC<ContextPanelProps> = ({
  budget,
  memoryNotes,
  includedMemoryIds,
  memoryRetrievalEnabled,
  onToggleMemoryRetrieval,
  hoveredSegment,
  onHoverSegment,
  onOpenPromptInspector,
}) => {
  const packed = getPackedTokens(budget);
  const free = getFreeTokens(budget);
  const pct = getPackedPercentage(budget);
  const limitLabel =
    budget.totalLimit >= 1024
      ? `${(budget.totalLimit / 1024).toFixed(budget.totalLimit % 1024 === 0 ? 0 : 1)}K model`
      : `${budget.totalLimit} tok`;

  const includedSet = new Set(includedMemoryIds);
  const activeNotesInPrompt = memoryNotes.filter(
    (n) => !n.isDisabled && (includedSet.has(n.id) || n.isPinned),
  );

  return (
    <aside
      aria-label="Context window and active memory"
      className="flex h-full w-[344px] shrink-0 flex-col overflow-y-auto border-l border-[#D3D8DF] bg-[#EEF0F3] px-[22px] pt-[22px] pb-7"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold text-[#161B26]">Context window</h2>
        <span className="text-[12.5px] text-[#778091]">{limitLabel}</span>
      </div>

      {/* Big Total Tokens Packed */}
      <div className="mt-3.5 flex flex-wrap items-baseline gap-1.5">
        <span
          data-testid="context-packed-tokens"
          className="text-[32px] leading-none font-bold tracking-tight text-[#161B26] tabular-nums"
        >
          {formatNumber(packed)}
        </span>
        <span className="text-[13px] text-[#778091]">
          of {formatNumber(budget.totalLimit)} tokens packed · {Math.round(pct)}%
        </span>
      </div>

      <p className="mt-1.5 text-[13px] text-[#444D5C]">
        {formatNumber(free)} still free for more history or memory.
      </p>

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
        className="mt-4 h-[38px] w-full rounded-[8px] border border-[#161B26] bg-white text-[13.5px] font-semibold text-[#161B26] transition-colors hover:bg-[#DDE1E7]"
      >
        Inspect exact prompt
      </button>

      {/* Memory in this prompt */}
      <div className="mt-7">
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-bold text-[#161B26]">Memory in this prompt</h3>
          <span className="text-[12px] text-[#778091]">
            {activeNotesInPrompt.length} of {memoryNotes.length} notes
          </span>
        </div>

        <div className="mt-2.5 space-y-2.5">
          {activeNotesInPrompt.length === 0 ? (
            <p className="text-[12.5px] italic text-[#778091]">
              No memory excerpts injected for this prompt.
            </p>
          ) : (
            activeNotesInPrompt.map((note) => (
              <div
                key={note.id}
                className="border-l-[3px] pl-3"
                style={{ borderColor: note.isPinned ? '#161B26' : '#8F9CF3' }}
              >
                <div className="text-[11.5px] text-[#778091]">
                  {note.isPinned ? 'Pinned project rule (always included)' : 'Retrieved as relevant'}
                </div>
                <div className="text-[13px] font-medium text-[#161B26]">{note.title}</div>
                <div className="line-clamp-2 text-[12px] text-[#444D5C]">{note.content}</div>
                <div className="mt-0.5 text-[11px] text-[#778091]">{note.sourceReference}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Memory Retrieval Toggle */}
      <div className="mt-5 flex items-center justify-between border-t border-[#D3D8DF] pt-4">
        <span className="text-[13px] text-[#444D5C]">Memory retrieval</span>
        <button
          type="button"
          role="switch"
          aria-checked={memoryRetrievalEnabled}
          aria-label="Toggle automatic memory retrieval"
          onClick={() => onToggleMemoryRetrieval(!memoryRetrievalEnabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            memoryRetrievalEnabled ? 'bg-[#2A3FE0]' : 'bg-[#AAB2BF]'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              memoryRetrievalEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </button>
      </div>
    </aside>
  );
};
