import React, { useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { formatNumber } from '../../core/privacy';
import type { PromptInspection } from '../../core/types';

interface PromptInspectorModalProps {
  isOpen: boolean;
  inspection: PromptInspection;
  onClose: () => void;
}

export const PromptInspectorModal: React.FC<PromptInspectorModalProps> = ({
  isOpen,
  inspection,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'rendered' | 'structured'>('rendered');

  if (!isOpen) return null;

  const displayPayload =
    viewMode === 'rendered'
      ? inspection.exactRenderedPrompt
      : JSON.stringify(
          inspection.tools && inspection.tools.length > 0
            ? { messages: inspection.structuredMessages, tools: inspection.tools }
            : inspection.structuredMessages,
          null,
          2,
        );

  const handleCopy = () => {
    void navigator.clipboard?.writeText(displayPayload).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-inspector-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
    >
      <div className="flex max-h-[88vh] w-full max-w-[740px] flex-col rounded-[10px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink)] shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-[var(--lc-surf-line)] px-5 py-4">
          <div>
            <h2 id="prompt-inspector-title" className="text-[16px] font-bold text-[var(--lc-surf-ink)]">
              Prompt Inspector — Exact Token Breakdown
            </h2>
            <p className="mt-0.5 text-[12.5px] text-[var(--lc-surf-mute)]">
              Deterministic context assembly ({inspection.templateType} · {inspection.tokenizerName})
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close prompt inspector"
            className="rounded-[6px] p-1 text-[var(--lc-surf-mute)] hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Quick Budget Stats Summary Card */}
          <div className="grid grid-cols-4 gap-3 rounded-[6px] border border-[var(--lc-line)] bg-[var(--lc-panel)] px-3.5 py-2.5 text-[var(--lc-side-ink)]">
            <div>
              <div className="text-[11px] text-[var(--lc-side-mute)]">Prompt Packed</div>
              <div className="text-[13px] font-bold text-[var(--lc-side-ink)]">
                {formatNumber(inspection.totalTokens)} / {formatNumber(inspection.budgetPartition.promptBudget)}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--lc-side-mute)]">Output Reserve</div>
              <div className="text-[13px] font-bold text-[var(--lc-side-ink)]">
                {formatNumber(inspection.budgetPartition.outputReserve)} tokens
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--lc-side-mute)]">Safety Margin</div>
              <div className="text-[13px] font-bold text-[var(--lc-side-ink)]">
                {formatNumber(inspection.budgetPartition.safetyMargin)} tokens
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[var(--lc-side-mute)]">Remaining Free</div>
              <div className="text-[13px] font-bold text-[var(--lc-success)]">
                {formatNumber(inspection.remainingCapacity)} tokens
              </div>
            </div>
          </div>

          {/* Packed Sections */}
          <div>
            <div className="mb-1.5 text-[11.5px] font-bold tracking-wider text-[var(--lc-surf-mute)]">
              PACKED SECTIONS
            </div>
            <div className="divide-y divide-[var(--lc-surf-line)] rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1">
              {inspection.sections.map((sec) => (
                <div key={`${sec.segmentKey}-${sec.name}`} className="flex items-center justify-between py-1.5">
                  <div>
                    <span className="text-[13px] font-medium text-[var(--lc-surf-ink)]">{sec.name}</span>
                    <span className="ml-2 text-[11.5px] text-[var(--lc-surf-mute)]">{sec.description}</span>
                  </div>
                  <span className="text-[13px] font-semibold text-[var(--lc-surf-ink2)] tabular-nums">
                    {formatNumber(sec.tokens)} tokens
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Included vs Excluded */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="mb-1.5 text-[11.5px] font-bold tracking-wider text-[var(--lc-success)]">
                INCLUDED IN THIS PROMPT ({inspection.includedItems.length})
              </div>
              <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-2.5 text-[12px]">
                {inspection.includedItems.map((item) => (
                  <div key={`${item.kind}-${item.id}`} className="text-[var(--lc-surf-ink)]">
                    <span className="font-semibold text-[var(--lc-success)]">✓</span> {item.label}{' '}
                    <span className="text-[var(--lc-surf-mute)]">({formatNumber(item.tokens)} tok)</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-[11.5px] font-bold tracking-wider text-[var(--lc-danger)]">
                EXCLUDED CANDIDATES & REASONS ({inspection.excludedCandidates.length})
              </div>
              <div className="max-h-36 space-y-2 overflow-y-auto rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-2.5 text-[12px]">
                {inspection.excludedCandidates.length === 0 ? (
                  <p className="italic text-[var(--lc-surf-mute)]">
                    No candidates trimmed — all items fit cleanly within the prompt budget.
                  </p>
                ) : (
                  inspection.excludedCandidates.map((ex) => (
                    <div key={`${ex.kind}-${ex.id}`}>
                      <div className="font-semibold text-[var(--lc-surf-ink2)]">✕ {ex.label}</div>
                      <div className="pl-3 text-[11px] text-[var(--lc-surf-mute)]">{ex.reason}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Exact Rendered Prompt vs Structured Messages Payload */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setViewMode('rendered')}
                  className={`rounded-[5px] px-2.5 py-1 text-[11.5px] font-semibold ${
                    viewMode === 'rendered'
                      ? 'bg-[var(--lc-active-pill-bg)] text-[var(--lc-active-pill-fg)]'
                      : 'bg-[var(--lc-panel)] text-[var(--lc-side-ink2)]'
                  }`}
                >
                  Rendered Template ({inspection.templateType})
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('structured')}
                  className={`rounded-[5px] px-2.5 py-1 text-[11.5px] font-semibold ${
                    viewMode === 'structured'
                      ? 'bg-[var(--lc-active-pill-bg)] text-[var(--lc-active-pill-fg)]'
                      : 'bg-[var(--lc-panel)] text-[var(--lc-side-ink2)]'
                  }`}
                >
                  OpenAI Chat API Messages (No Double-Wrap)
                </button>
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1 text-[12px] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-[var(--lc-success)]" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copied ? 'Copied' : 'Copy prompt'}</span>
              </button>
            </div>
            <textarea
              readOnly
              aria-label="Exact assembled prompt payload"
              value={displayPayload}
              rows={7}
              className="w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-bg)] p-3 font-mono text-[12px] leading-relaxed text-[var(--lc-ink)] focus:outline-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-[var(--lc-surf-line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] bg-[var(--lc-accent)] px-4 py-1.5 text-[13px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)]"
          >
            Close Inspector
          </button>
        </div>
      </div>
    </div>
  );
};
