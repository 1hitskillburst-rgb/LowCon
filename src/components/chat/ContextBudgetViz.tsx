import React from 'react';
import { formatNumber } from '../../core/privacy';
import type { ContextSegment, ContextSegmentKey, TurnContextBudget } from '../../core/types';

const SEGMENT_CSS_VARS: Record<ContextSegmentKey, string> = {
  core: 'var(--lc-seg-core, #161B26)',
  task: 'var(--lc-accent, #2A3FE0)',
  mem: 'var(--lc-seg-mem, #8F9CF3)',
  recent: 'var(--lc-seg-recent, #F2D452)',
  tpl: 'var(--lc-seg-tpl, #AAB2BF)',
  free: 'var(--lc-seg-free, #EAEEF2)',
  out: 'var(--lc-hold, #C6CCD6)',
  safe: 'var(--lc-hold, #C6CCD6)',
};

interface StripProps {
  budget: TurnContextBudget;
  hoveredKey: ContextSegmentKey | null;
  onHoverChange: (key: ContextSegmentKey | null) => void;
}

export const ContextStrip: React.FC<StripProps> = ({ budget, hoveredKey, onHoverChange }) => {
  const total = Math.max(1, budget.totalLimit);

  return (
    <div
      className="flex h-[10px] w-full items-stretch gap-[2px]"
      onMouseLeave={() => onHoverChange(null)}
      aria-label="Turn context token breakdown strip"
    >
      {budget.segments.map((seg) => {
        const pct = Math.max(1.2, (seg.tokens / total) * 100);
        const isHovered = hoveredKey === seg.key;
        const isDimmed = hoveredKey !== null && !isHovered;

        return (
          <div
            key={`${seg.key}-${seg.name}`}
            style={{
              width: `${pct}%`,
              backgroundColor: seg.isFree ? 'transparent' : SEGMENT_CSS_VARS[seg.key] || seg.color,
              opacity: isDimmed ? 0.3 : 1,
            }}
            onMouseEnter={() => onHoverChange(seg.key)}
            title={`${seg.name}: ${formatNumber(seg.tokens)} tokens (${((seg.tokens / total) * 100).toFixed(1)}%) — ${seg.description}`}
            className={`h-full rounded-[2px] transition-opacity ${
              seg.isFree ? 'border border-[var(--lc-seg-tpl)]' : ''
            }`}
          />
        );
      })}
    </div>
  );
};

interface VerticalStackProps {
  budget: TurnContextBudget;
  hoveredKey: ContextSegmentKey | null;
  onHoverChange: (key: ContextSegmentKey | null) => void;
}

export const VerticalContextStack: React.FC<VerticalStackProps> = ({
  budget,
  hoveredKey,
  onHoverChange,
}) => {
  const total = Math.max(1, budget.totalLimit);

  return (
    <div
      className="flex h-[320px] w-[44px] shrink-0 flex-col gap-[2px]"
      onMouseLeave={() => onHoverChange(null)}
      aria-label="Vertical context budget stack"
    >
      {budget.segments.map((seg) => {
        const pct = Math.max(2.5, (seg.tokens / total) * 100);
        const isHovered = hoveredKey === seg.key;
        const isDimmed = hoveredKey !== null && !isHovered;

        return (
          <div
            key={`${seg.key}-${seg.name}`}
            style={{
              flexGrow: pct,
              minHeight: '6px',
              backgroundColor: seg.isFree ? 'transparent' : SEGMENT_CSS_VARS[seg.key] || seg.color,
              opacity: isDimmed ? 0.25 : 1,
            }}
            onMouseEnter={() => onHoverChange(seg.key)}
            title={`${seg.name}: ${formatNumber(seg.tokens)} tokens — ${seg.description}`}
            className={`w-full rounded-[3px] transition-opacity ${
              seg.isFree ? 'border-[1.5px] border-[var(--lc-seg-tpl)]' : ''
            }`}
          />
        );
      })}
    </div>
  );
};

interface RowProps {
  segment: ContextSegment;
  isHovered: boolean;
  onHoverChange: (key: ContextSegmentKey | null) => void;
}

export const ContextSegmentRow: React.FC<RowProps> = ({
  segment,
  isHovered,
  onHoverChange,
}) => {
  return (
    <div
      onMouseEnter={() => onHoverChange(segment.key)}
      onMouseLeave={() => onHoverChange(null)}
      className={`flex items-center justify-between gap-2 border-b border-[var(--lc-panel-line)] px-1.5 py-1.5 transition-colors ${
        isHovered ? 'rounded-[4px] bg-[var(--lc-hover)]' : ''
      }`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          aria-hidden="true"
          style={{
            backgroundColor: segment.isFree ? 'transparent' : SEGMENT_CSS_VARS[segment.key] || segment.color,
          }}
          className={`mt-1 h-2 w-2 shrink-0 rounded-[1px] ${
            segment.isFree ? 'border border-[var(--lc-seg-tpl)]' : ''
          }`}
        />
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold text-[var(--lc-panel-ink)]">
            {segment.name}
          </div>
          <div className="truncate text-[11px] text-[var(--lc-panel-mute)]">{segment.description}</div>
        </div>
      </div>
      <span
        className={`shrink-0 text-[12.5px] font-semibold tabular-nums ${
          segment.isFree ? 'text-[var(--lc-success)]' : 'text-[var(--lc-panel-ink2)]'
        }`}
      >
        {formatNumber(segment.tokens)}
      </span>
    </div>
  );
};
