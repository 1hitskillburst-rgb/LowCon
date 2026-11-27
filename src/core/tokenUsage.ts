import type { Session, TokenUsageHistory } from './types';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTH_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export function toLocalDateKey(dateOrMs: Date | number): string {
  const d = typeof dateOrMs === 'number' ? new Date(dateOrMs) : dateOrMs;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createEmptyTokenUsage(): TokenUsageHistory {
  return {
    totalLifetimeTokens: 0,
    dailyTokens: {},
  };
}

export function sanitizeTokenUsageHistory(
  raw: Partial<TokenUsageHistory> | undefined,
  fallbackSessions?: Session[],
): TokenUsageHistory {
  if (!raw || typeof raw !== 'object') {
    return fallbackSessions ? backfillTokenUsageFromSessions(fallbackSessions) : createEmptyTokenUsage();
  }

  const dailyTokens: Record<string, number> = {};
  let sumDaily = 0;

  if (raw.dailyTokens && typeof raw.dailyTokens === 'object') {
    for (const [key, val] of Object.entries(raw.dailyTokens)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        const cleanVal = Math.round(val);
        dailyTokens[key] = cleanVal;
        sumDaily += cleanVal;
      }
    }
  }

  const rawLifetime =
    typeof raw.totalLifetimeTokens === 'number' && Number.isFinite(raw.totalLifetimeTokens)
      ? Math.max(0, Math.round(raw.totalLifetimeTokens))
      : 0;

  return {
    totalLifetimeTokens: Math.max(rawLifetime, sumDaily),
    dailyTokens,
  };
}

export function backfillTokenUsageFromSessions(sessions: Session[]): TokenUsageHistory {
  const dailyTokens: Record<string, number> = {};
  let totalLifetimeTokens = 0;

  for (const session of sessions) {
    for (const msg of session.messages) {
      if (msg.role !== 'assistant' || msg.isError) continue;
      const completionTokens =
        typeof msg.tokenCount === 'number' && Number.isFinite(msg.tokenCount) && msg.tokenCount > 0
          ? Math.round(msg.tokenCount)
          : 0;
      const promptTokens = msg.turnBudget
        ? msg.turnBudget.segments
            .filter((s) => !s.isHeld && !s.isFree)
            .reduce((sum, s) => sum + Math.max(0, s.tokens), 0)
        : 0;
      const msgTotal = completionTokens + promptTokens;
      if (msgTotal <= 0) continue;

      const dateKey = toLocalDateKey(msg.createdAt);
      dailyTokens[dateKey] = (dailyTokens[dateKey] ?? 0) + msgTotal;
      totalLifetimeTokens += msgTotal;
    }
  }

  return { totalLifetimeTokens, dailyTokens };
}

export function addTokenUsage(
  current: TokenUsageHistory | undefined,
  tokens: number,
  timestampMs = Date.now(),
): TokenUsageHistory {
  const base = sanitizeTokenUsageHistory(current);
  const delta = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
  if (delta <= 0) return base;

  const dateKey = toLocalDateKey(timestampMs);
  return {
    totalLifetimeTokens: base.totalLifetimeTokens + delta,
    dailyTokens: {
      ...base.dailyTokens,
      [dateKey]: (base.dailyTokens[dateKey] ?? 0) + delta,
    },
  };
}

/**
 * Formats token counts compactly for calendar tooltips & summaries:
 * - < 1,000 => "842"
 * - 1,000..999,949 => "34.1k" (strips trailing ".0" like "1k")
 * - >= 999,950 => "1.2M", "1.5B"
 */
export function formatCompactTokens(tokens: number): string {
  const safe = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0));
  if (safe < 1000) return String(safe);
  if (safe < 999_950) {
    return `${(safe / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  if (safe < 999_950_000) {
    return `${(safe / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${(safe / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
}

function getOrdinalSuffix(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  switch (day % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

export function formatCalendarTooltipDate(date: Date, includeYear = false): string {
  const month = MONTH_FULL[date.getMonth()];
  const day = date.getDate();
  const base = `${month} ${day}${getOrdinalSuffix(day)}`;
  return includeYear ? `${base}, ${date.getFullYear()}` : base;
}

export function formatCalendarTooltipText(
  tokens: number,
  date: Date,
  includeYear = false,
): string {
  const formattedDate = formatCalendarTooltipDate(date, includeYear);
  if (tokens <= 0) {
    return `No tokens used on ${formattedDate}.`;
  }
  return `${formatCompactTokens(tokens)} tokens used on ${formattedDate}.`;
}

export interface CalendarDayCell {
  dateKey: string;
  date: Date;
  tokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  inRange: boolean;
}

export interface CalendarMonthLabel {
  weekIndex: number;
  label: string;
}

export interface TokenCalendarGrid {
  weeks: CalendarDayCell[][];
  monthLabels: CalendarMonthLabel[];
  totalTokensInRange: number;
  maxDailyTokens: number;
  activeDaysCount: number;
}

export function computeIntensityLevel(tokens: number, maxDailyTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || maxDailyTokens <= 0) return 0;
  const ratio = tokens / maxDailyTokens;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

export function getAvailableCalendarYears(
  dailyTokens: Record<string, number>,
  now = new Date(),
): number[] {
  const currentYear = now.getFullYear();
  const years = new Set<number>([currentYear, currentYear - 1]);
  for (const [key, val] of Object.entries(dailyTokens)) {
    if (val > 0 && /^\d{4}-/.test(key)) {
      const yr = Number.parseInt(key.slice(0, 4), 10);
      if (Number.isFinite(yr) && yr <= currentYear) {
        years.add(yr);
      }
    }
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * Builds a GitHub-style 7-row (Sun..Sat) contribution calendar grid.
 * - For `year === null` or `year === now.getFullYear()`, builds the rolling last-year window ending today (matching GitHub's default graph).
 * - For a past `year`, builds Jan 1..Dec 31 of that year.
 */
export function buildTokenCalendarGrid(
  dailyTokens: Record<string, number>,
  selectedYear: number | null,
  now = new Date(),
): TokenCalendarGrid {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const currentYear = today.getFullYear();
  const isRolling = selectedYear === null || selectedYear === currentYear;

  let rangeStart: Date;
  let rangeEnd: Date;

  if (isRolling) {
    rangeEnd = today;
    rangeStart = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    // Align rolling window similarly to GitHub (~52-53 weeks ending on today's week)
    rangeStart.setDate(rangeStart.getDate() + 1);
  } else {
    rangeStart = new Date(selectedYear, 0, 1);
    rangeEnd = new Date(selectedYear, 11, 31);
  }

  // Pad grid start backward to Sunday and grid end forward to Saturday
  const gridStart = new Date(rangeStart);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());

  const gridEnd = new Date(rangeEnd);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

  const rawWeeks: Array<Array<Omit<CalendarDayCell, 'level'>>> = [];
  let totalTokensInRange = 0;
  let maxDailyTokens = 0;
  let activeDaysCount = 0;

  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const week: Array<Omit<CalendarDayCell, 'level'>> = [];
    for (let dow = 0; dow < 7; dow++) {
      const cellDate = new Date(cursor);
      const inRange = cellDate >= rangeStart && cellDate <= rangeEnd;
      const dateKey = toLocalDateKey(cellDate);
      const tokens = inRange ? Math.max(0, Math.round(dailyTokens[dateKey] ?? 0)) : 0;

      if (inRange && tokens > 0) {
        totalTokensInRange += tokens;
        activeDaysCount += 1;
        if (tokens > maxDailyTokens) {
          maxDailyTokens = tokens;
        }
      }

      week.push({
        dateKey,
        date: cellDate,
        tokens,
        inRange,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    rawWeeks.push(week);
  }

  const weeks: CalendarDayCell[][] = rawWeeks.map((week) =>
    week.map((cell) => ({
      ...cell,
      level: cell.inRange ? computeIntensityLevel(cell.tokens, maxDailyTokens) : 0,
    })),
  );

  // Month labels placed above the week where each month first appears in range
  const monthLabels: CalendarMonthLabel[] = [];
  let lastLabeledMonth = -1;
  let lastLabeledWeek = -10;

  for (let w = 0; w < weeks.length; w++) {
    const inRangeDays = weeks[w].filter((d) => d.inRange);
    if (inRangeDays.length === 0) continue;

    // If week 0 is a tiny partial stub (< 4 days) and the next month starts in week 1,
    // skip labeling the stub so the following month (e.g. Dec) isn't suppressed.
    if (w === 0 && inRangeDays.length < 4 && weeks[1]?.some((d) => d.inRange && d.date.getDate() === 1)) {
      lastLabeledMonth = inRangeDays[0].date.getMonth();
      continue;
    }

    const firstDayOfMonth = inRangeDays.find((d) => d.date.getDate() === 1);
    const candidate = firstDayOfMonth ?? (w === 0 ? inRangeDays[0] : undefined);
    if (!candidate) continue;

    const month = candidate.date.getMonth();
    if (month !== lastLabeledMonth) {
      if (w - lastLabeledWeek >= 2) {
        monthLabels.push({ weekIndex: w, label: MONTH_ABBR[month] });
        lastLabeledWeek = w;
      }
      lastLabeledMonth = month;
    }
  }

  return {
    weeks,
    monthLabels,
    totalTokensInRange,
    maxDailyTokens,
    activeDaysCount,
  };
}
