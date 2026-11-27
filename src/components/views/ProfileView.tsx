import React, { useMemo, useRef, useState } from 'react';
import { Calendar, Sparkles, User } from 'lucide-react';
import { estimateTokensConservative } from '../../core/context';
import { formatNumber } from '../../core/privacy';
import {
  buildTokenCalendarGrid,
  formatCalendarTooltipText,
  formatCompactTokens,
  getAvailableCalendarYears,
  toLocalDateKey,
  type CalendarDayCell,
} from '../../core/tokenUsage';
import type { TokenUsageHistory, UserProfileSettings } from '../../core/types';

interface ProfileViewProps {
  profile: UserProfileSettings;
  tokenUsage: TokenUsageHistory;
  onUpdateProfile: (patch: Partial<UserProfileSettings>) => void;
}

const WEEK_STEP_PX = 13; // 10px cell + 3px gap
const WEEKDAY_COL_PX = 32; // 28px label + 4px margin

export const ProfileView: React.FC<ProfileViewProps> = ({
  profile,
  tokenUsage,
  onUpdateProfile,
}) => {
  const now = useMemo(() => new Date(), []);
  const currentYear = now.getFullYear();
  const availableYears = useMemo(
    () => getAvailableCalendarYears(tokenUsage.dailyTokens, now),
    [tokenUsage.dailyTokens, now],
  );
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const calendarCardRef = useRef<HTMLDivElement | null>(null);
  const [hoveredCell, setHoveredCell] = useState<{
    cell: CalendarDayCell;
    dayIndex: number;
    centerX: number;
    topY: number;
    bottomY: number;
    cardWidth: number;
  } | null>(null);

  const handleCellActivate = (el: HTMLButtonElement, cell: CalendarDayCell, dayIndex: number) => {
    const cardEl = calendarCardRef.current;
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

  const effectiveYear = availableYears.includes(selectedYear) ? selectedYear : currentYear;
  const isRollingCurrentYear = effectiveYear === currentYear;

  const calendarGrid = useMemo(
    () => buildTokenCalendarGrid(tokenUsage.dailyTokens, effectiveYear, now),
    [tokenUsage.dailyTokens, effectiveYear, now],
  );

  const todayKey = toLocalDateKey(now);
  const todayTokens = tokenUsage.dailyTokens[todayKey] ?? 0;
  const customPromptTokens = profile.customSystemPrompt.trim()
    ? estimateTokensConservative(profile.customSystemPrompt.trim())
    : 0;

  const periodLabel = isRollingCurrentYear ? 'the last year' : String(effectiveYear);

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
          <section className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-5 text-[var(--lc-surf-ink)]">
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
                      className="rounded-[5px] border border-[var(--lc-surf-line)] bg-[var(--lc-surf-hover)]/50 px-2 py-0.5 text-[11px] font-medium text-[var(--lc-surf-ink2)] tabular-nums"
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

          {/* 2. Token Usage & GitHub-Style Activity Calendar */}
          <section className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-5 text-[var(--lc-surf-ink)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-[var(--lc-surf-ink)]" />
                <h2 className="text-[15px] font-bold text-[var(--lc-surf-ink)]">
                  Token Activity
                </h2>
              </div>

              <div
                data-testid="lifetime-tokens-badge"
                className="inline-flex items-center gap-2 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-bg)] px-3 py-1 text-[12.5px]"
              >
                <span className="text-[var(--lc-surf-mute)]">Total tokens lifetime:</span>
                <span
                  data-testid="lifetime-tokens-value"
                  className="font-bold text-[var(--lc-surf-ink)] tabular-nums"
                  title={`${formatNumber(tokenUsage.totalLifetimeTokens)} tokens`}
                >
                  {formatCompactTokens(tokenUsage.totalLifetimeTokens)}
                </span>
                <span className="text-[11px] text-[var(--lc-surf-mute)] tabular-nums">
                  ({formatNumber(tokenUsage.totalLifetimeTokens)})
                </span>
              </div>
            </div>

            {/* Summary Stats Strip */}
            <div className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <div className="rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-bg)]/55 px-3.5 py-2.5">
                <div className="text-[11.5px] font-medium text-[var(--lc-surf-mute)]">
                  Total tokens lifetime
                </div>
                <div className="mt-0.5 text-[18px] font-bold text-[var(--lc-surf-ink)] tabular-nums">
                  {formatCompactTokens(tokenUsage.totalLifetimeTokens)}
                </div>
              </div>

              <div className="rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-bg)]/55 px-3.5 py-2.5">
                <div className="text-[11.5px] font-medium text-[var(--lc-surf-mute)]">
                  Tokens used in {periodLabel}
                </div>
                <div
                  data-testid="period-tokens-value"
                  className="mt-0.5 text-[18px] font-bold text-[var(--lc-surf-ink)] tabular-nums"
                >
                  {formatCompactTokens(calendarGrid.totalTokensInRange)}
                </div>
              </div>

              <div className="rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-bg)]/55 px-3.5 py-2.5">
                <div className="text-[11.5px] font-medium text-[var(--lc-surf-mute)]">
                  Today · Active days ({periodLabel})
                </div>
                <div className="mt-0.5 text-[18px] font-bold text-[var(--lc-surf-ink)] tabular-nums">
                  {formatCompactTokens(todayTokens)}{' '}
                  <span className="text-[12.5px] font-normal text-[var(--lc-surf-mute)]">
                    · {calendarGrid.activeDaysCount}{' '}
                    {calendarGrid.activeDaysCount === 1 ? 'day' : 'days'}
                  </span>
                </div>
              </div>
            </div>

            {/* Calendar Header + Grid + Year Rail */}
            <div className="mt-5">
              <div
                data-testid="calendar-period-heading"
                className="mb-2 text-[13.5px] font-semibold text-[var(--lc-surf-ink)] tabular-nums"
              >
                {formatCompactTokens(calendarGrid.totalTokensInRange)} tokens used in {periodLabel}
              </div>

              <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
                {/* Calendar Card */}
                <div
                  ref={calendarCardRef}
                  onMouseLeave={() => setHoveredCell(null)}
                  className="relative min-w-0 flex-1 rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-bg)]/45 p-3.5"
                >
                  {/* Floating GitHub-style Hover Tooltip (outside overflow-x-auto so never clipped) */}
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
                          hoveredCell.dayIndex <= 2
                            ? `${hoveredCell.bottomY + 8}px`
                            : `${hoveredCell.topY - 8}px`,
                      }}
                      className={`pointer-events-none absolute z-30 -translate-x-1/2 rounded-[6px] border border-[var(--lc-surf-line)] bg-[#1F2328] px-2.5 py-1 text-[11.5px] font-medium whitespace-nowrap text-white shadow-lg ${
                        hoveredCell.dayIndex <= 2 ? '' : '-translate-y-full'
                      }`}
                    >
                      {formatCalendarTooltipText(
                        hoveredCell.cell.tokens,
                        hoveredCell.cell.date,
                        !isRollingCurrentYear,
                      )}
                    </div>
                  )}

                  <div className="overflow-x-auto pb-1">
                    <div className="relative inline-block min-w-max pt-1">
                      {/* Month Labels */}
                      <div
                        className="relative mb-1.5 h-[15px] text-[11px] text-[var(--lc-surf-mute)]"
                        style={{ marginLeft: `${WEEKDAY_COL_PX}px` }}
                      >
                        {calendarGrid.monthLabels.map((m) => (
                          <span
                            key={`${m.label}-${m.weekIndex}`}
                            style={{ left: `${m.weekIndex * WEEK_STEP_PX}px` }}
                            className="absolute top-0 leading-none"
                          >
                            {m.label}
                          </span>
                        ))}
                      </div>

                      {/* Weekday Labels + 7xN Grid */}
                      <div className="flex items-start">
                        <div
                          aria-hidden="true"
                          className="mr-[4px] flex w-[28px] shrink-0 flex-col gap-[3px] text-[10.5px] leading-[10px] text-[var(--lc-surf-mute)]"
                        >
                          <span className="h-[10px]" />
                          <span className="flex h-[10px] items-center">Mon</span>
                          <span className="h-[10px]" />
                          <span className="flex h-[10px] items-center">Wed</span>
                          <span className="h-[10px]" />
                          <span className="flex h-[10px] items-center">Fri</span>
                          <span className="h-[10px]" />
                        </div>

                        <div
                          className="flex gap-[3px]"
                          role="grid"
                          aria-label={`Daily token usage calendar for ${periodLabel}`}
                        >
                          {calendarGrid.weeks.map((week, wIdx) => (
                            <div key={week[0]?.dateKey ?? wIdx} className="flex flex-col gap-[3px]">
                              {week.map((cell, dIdx) => {
                                if (!cell.inRange) {
                                  return (
                                    <span
                                      key={cell.dateKey}
                                      aria-hidden="true"
                                      className="block h-[10px] w-[10px]"
                                    />
                                  );
                                }
                                const tooltip = formatCalendarTooltipText(
                                  cell.tokens,
                                  cell.date,
                                  !isRollingCurrentYear,
                                );
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
                                    className="block h-[10px] w-[10px] rounded-[2px] border border-black/5 transition-transform hover:ring-1 hover:ring-[var(--lc-surf-ink)]/60 focus:ring-1 focus:ring-[var(--lc-accent)] focus:outline-none"
                                  />
                                );
                              })}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Calendar Footer & Legend */}
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--lc-surf-mute)]">
                    <span>Tracks local prompt + completion tokens across all models</span>
                    <div className="flex items-center gap-1">
                      <span>Less</span>
                      {([0, 1, 2, 3, 4] as const).map((lvl) => (
                        <span
                          key={lvl}
                          aria-hidden="true"
                          style={{ backgroundColor: `var(--lc-contrib-${lvl})` }}
                          className="inline-block h-[10px] w-[10px] rounded-[2px] border border-black/5"
                        />
                      ))}
                      <span>More</span>
                    </div>
                  </div>
                </div>

                {/* Year Selector Rail (matches GitHub right-hand year pills) */}
                <div
                  className="flex shrink-0 flex-row gap-1.5 lg:w-[82px] lg:flex-col"
                  role="group"
                  aria-label="Select calendar year"
                >
                  {availableYears.map((yr) => {
                    const isSelected = yr === effectiveYear;
                    return (
                      <button
                        key={yr}
                        type="button"
                        data-testid={`calendar-year-${yr}`}
                        onClick={() => {
                          setHoveredCell(null);
                          setSelectedYear(yr);
                        }}
                        className={`rounded-[6px] px-3 py-1.5 text-left text-[12px] font-medium transition-colors tabular-nums ${
                          isSelected
                            ? 'bg-[var(--lc-accent)] font-semibold text-[var(--lc-accent-contrast)]'
                            : 'text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]'
                        }`}
                      >
                        {yr}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
