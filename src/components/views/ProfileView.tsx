import React, { useMemo, useRef, useState } from 'react';
import { Sparkles, User } from 'lucide-react';
import { estimateTokensConservative } from '../../core/context';
import { formatNumber } from '../../core/privacy';
import {
  buildRecentTokenHeatmapGrid,
  computeTokenUsageStats,
  formatCalendarTooltipText,
  formatCompactTokens,
  formatStreakDays,
  type CalendarDayCell,
} from '../../core/tokenUsage';
import type { TokenUsageHistory, UserProfileSettings } from '../../core/types';

interface ProfileViewProps {
  profile: UserProfileSettings;
  tokenUsage: TokenUsageHistory;
  onUpdateProfile: (patch: Partial<UserProfileSettings>) => void;
}

const HEATMAP_WEEKS = 26;

export const ProfileView: React.FC<ProfileViewProps> = ({
  profile,
  tokenUsage,
  onUpdateProfile,
}) => {
  const now = useMemo(() => new Date(), []);
  const heatmapCardRef = useRef<HTMLDivElement | null>(null);
  const [hoveredCell, setHoveredCell] = useState<{
    cell: CalendarDayCell;
    dayIndex: number;
    centerX: number;
    topY: number;
    bottomY: number;
    cardWidth: number;
  } | null>(null);

  const handleCellActivate = (el: HTMLButtonElement, cell: CalendarDayCell, dayIndex: number) => {
    const cardEl = heatmapCardRef.current;
    if (!cardEl) return;
    const cardRect = cardEl.getBoundingClientRect();
    const cellRect = el.getBoundingClientRect();
    setHoveredCell({
      cell,
      dayIndex,
      centerX: cellRect.left - cardRect.left + cellRect.width / 2,
      topY: cellRect.top - cardRect.top,
      bottomY: cellRect.bottom - cardRect.top,
      cardWidth: cardRect.width,
    });
  };

  const heatmapGrid = useMemo(
    () => buildRecentTokenHeatmapGrid(tokenUsage.dailyTokens, HEATMAP_WEEKS, now),
    [tokenUsage.dailyTokens, now],
  );

  const stats = useMemo(
    () => computeTokenUsageStats(tokenUsage, now),
    [tokenUsage, now],
  );

  const customPromptTokens = profile.customSystemPrompt.trim()
    ? estimateTokensConservative(profile.customSystemPrompt.trim())
    : 0;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--lc-bg)] text-[var(--lc-ink)]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--lc-line)] px-7 py-3">
        <div className="flex items-center text-[13px]">
          <span className="text-[var(--lc-mute)]">Workspace /</span>
          <span className="ml-1 font-semibold text-[var(--lc-ink)]">Profile</span>
        </div>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[900px] space-y-5 pb-8">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight text-[var(--lc-ink)]">
              Profile &amp; Token Usage
            </h1>
            <p className="mt-1 text-[13.5px] text-[var(--lc-ink2)]">
              Set the name local models address you by, add a custom system prompt, and track your
              daily and lifetime token usage locally.
            </p>
          </div>

          {/* 1. User Identity & Custom System Prompt */}
          <section className="rounded-[10px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-5 text-[var(--lc-surf-ink)]">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-[var(--lc-surf-ink)]" />
              <h2 className="text-[15px] font-bold text-[var(--lc-surf-ink)]">
                Identity &amp; Custom System Prompt
              </h2>
            </div>
            <p className="mt-1 text-[12.5px] text-[var(--lc-surf-mute)]">
              Stored locally in your workspace (and encrypted at rest when Vault is enabled).
            </p>

            <div className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="profile-username-input"
                  className="block text-[12.5px] font-semibold text-[var(--lc-surf-ink)]"
                >
                  Username
                </label>
                <p className="mt-0.5 text-[12px] text-[var(--lc-surf-mute)]">
                  The LLM is instructed to address you by this name, and your chat turns appear
                  under it.
                </p>
                <input
                  id="profile-username-input"
                  data-testid="profile-username-input"
                  type="text"
                  maxLength={64}
                  value={profile.username}
                  placeholder="Enter your name (e.g. Alex)"
                  onChange={(e) => onUpdateProfile({ username: e.target.value })}
                  className="mt-1.5 w-full max-w-[360px] rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[13px] text-[var(--lc-surf-ink)] placeholder:text-[var(--lc-surf-mute)] focus:border-[var(--lc-accent)] focus:outline-none"
                />
              </div>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor="profile-system-prompt-input"
                    className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--lc-surf-ink)]"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-[var(--lc-accent)]" />
                    <span>Custom System Prompt</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <span
                      data-testid="profile-system-prompt-tokens"
                      className="text-[11.5px] font-medium text-[var(--lc-surf-mute)] tabular-nums"
                    >
                      ~{formatNumber(customPromptTokens)} tokens
                    </span>
                    {profile.customSystemPrompt.trim().length > 0 && (
                      <button
                        type="button"
                        onClick={() => onUpdateProfile({ customSystemPrompt: '' })}
                        className="rounded-[5px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-0.5 text-[12px] text-[var(--lc-surf-mute)]">
                  Appended to LowCon&apos;s core system instructions on every turn within your
                  prompt budget.
                </p>
                <textarea
                  id="profile-system-prompt-input"
                  data-testid="profile-system-prompt-input"
                  rows={4}
                  value={profile.customSystemPrompt}
                  placeholder="Optional persistent instructions (e.g. tone, preferred languages, formatting rules)..."
                  onChange={(e) => onUpdateProfile({ customSystemPrompt: e.target.value })}
                  className="mt-1.5 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-2 text-[13px] leading-relaxed text-[var(--lc-surf-ink)] placeholder:text-[var(--lc-surf-mute)] focus:border-[var(--lc-accent)] focus:outline-none"
                />
              </div>
            </div>
          </section>

          {/* 2. Token Activity Heatmap & 4-Stat Strip */}
          <section
            ref={heatmapCardRef}
            onMouseLeave={() => setHoveredCell(null)}
            aria-label="Token usage tracker"
            data-testid="token-tracker-card"
            className="relative rounded-[12px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-6 text-[var(--lc-surf-ink)]"
          >
            {/* Floating Hover Tooltip */}
            {hoveredCell && (
              <div
                role="status"
                data-testid="calendar-tooltip"
                style={{
                  left: `${Math.min(
                    Math.max(115, hoveredCell.centerX),
                    Math.max(115, hoveredCell.cardWidth - 115),
                  )}px`,
                  top:
                    hoveredCell.dayIndex <= 1
                      ? `${hoveredCell.bottomY + 8}px`
                      : `${hoveredCell.topY - 8}px`,
                }}
                className={`pointer-events-none absolute z-30 -translate-x-1/2 rounded-[6px] border border-[var(--lc-surf-line)] bg-[#1B1E24] px-2.5 py-1 text-[11.5px] font-medium whitespace-nowrap text-white shadow-lg ${
                  hoveredCell.dayIndex <= 1 ? '' : '-translate-y-full'
                }`}
              >
                {formatCalendarTooltipText(hoveredCell.cell.tokens, hoveredCell.cell.date, true)}
              </div>
            )}

            {/* 26x7 Rounded-Square Heatmap */}
            <div className="overflow-x-auto pb-1">
              <div
                role="grid"
                aria-label="Daily token usage heatmap for the last 26 weeks"
                className="grid min-w-[540px] grid-cols-[repeat(26,minmax(0,1fr))] gap-[5px] sm:gap-[6px]"
              >
                {heatmapGrid.weeks.map((week, wIdx) => (
                  <div
                    key={week[0]?.dateKey ?? wIdx}
                    className="flex flex-col gap-[5px] sm:gap-[6px]"
                  >
                    {week.map((cell, dIdx) => {
                      if (!cell.inRange) {
                        return (
                          <span
                            key={cell.dateKey}
                            aria-hidden="true"
                            className="block aspect-square w-full"
                          />
                        );
                      }
                      const tooltip = formatCalendarTooltipText(cell.tokens, cell.date, true);
                      return (
                        <button
                          key={cell.dateKey}
                          type="button"
                          data-testid={`calendar-day-${cell.dateKey}`}
                          data-level={cell.level}
                          aria-label={tooltip}
                          onMouseEnter={(e) => handleCellActivate(e.currentTarget, cell, dIdx)}
                          onFocus={(e) => handleCellActivate(e.currentTarget, cell, dIdx)}
                          onBlur={() => setHoveredCell(null)}
                          style={{
                            backgroundColor: `var(--lc-contrib-${cell.level})`,
                          }}
                          className="block aspect-square w-full rounded-[5px] transition-[filter,transform] duration-150 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-[var(--lc-accent)] focus-visible:outline-none sm:rounded-[6px]"
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* 4-Column Centered Stat Row */}
            <div
              data-testid="token-tracker-stats"
              className="mt-7 grid grid-cols-2 gap-y-5 sm:grid-cols-4 sm:gap-y-0 sm:divide-x sm:divide-[var(--lc-surf-line)]/55"
            >
              <div className="px-3 text-center">
                <div
                  data-testid="lifetime-tokens-value"
                  title={`${formatNumber(stats.lifetimeTokens)} tokens`}
                  className="text-[26px] leading-tight font-semibold tracking-tight text-[var(--lc-surf-ink)] tabular-nums sm:text-[28px]"
                >
                  {formatCompactTokens(stats.lifetimeTokens)}
                </div>
                <div className="mt-1.5 text-[13.5px] font-normal text-[var(--lc-surf-mute)]">
                  lifetime tokens
                </div>
              </div>

              <div className="px-3 text-center">
                <div
                  data-testid="peak-day-tokens-value"
                  title={
                    stats.peakDayDateKey
                      ? `${formatNumber(stats.peakDayTokens)} tokens on ${stats.peakDayDateKey}`
                      : 'No peak day recorded yet'
                  }
                  className="text-[26px] leading-tight font-semibold tracking-tight text-[var(--lc-surf-ink)] tabular-nums sm:text-[28px]"
                >
                  {formatCompactTokens(stats.peakDayTokens)}
                </div>
                <div className="mt-1.5 text-[13.5px] font-normal text-[var(--lc-surf-mute)]">
                  peak day
                </div>
              </div>

              <div className="px-3 text-center">
                <div
                  data-testid="current-streak-value"
                  className="text-[26px] leading-tight font-semibold tracking-tight text-[var(--lc-surf-ink)] tabular-nums sm:text-[28px]"
                >
                  {formatStreakDays(stats.currentStreakDays)}
                </div>
                <div className="mt-1.5 text-[13.5px] font-normal text-[var(--lc-surf-mute)]">
                  current streak
                </div>
              </div>

              <div className="px-3 text-center">
                <div
                  data-testid="longest-streak-value"
                  className="text-[26px] leading-tight font-semibold tracking-tight text-[var(--lc-surf-ink)] tabular-nums sm:text-[28px]"
                >
                  {formatStreakDays(stats.longestStreakDays)}
                </div>
                <div className="mt-1.5 text-[13.5px] font-normal text-[var(--lc-surf-mute)]">
                  longest streak
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

