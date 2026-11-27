import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarNav } from '../src/components/layout/SidebarNav.tsx';
import { ProfileView } from '../src/components/views/ProfileView.tsx';
import { generateDeterministicMockReply } from '../src/core/inference.ts';
import { DiagnosticLogger } from '../src/core/privacy.ts';
import {
  clearActiveVaultKey,
  createDefaultWorkspace,
  loadUnsealedWorkspace,
  saveUnsealedWorkspace,
  sealWorkspaceVault,
  unsealWorkspaceVault,
} from '../src/core/storage.ts';
import { computeThemeCssVariables, THEME_PRESETS } from '../src/core/theme.ts';
import {
  addTokenUsage,
  backfillTokenUsageFromSessions,
  buildRecentTokenHeatmapGrid,
  buildTokenCalendarGrid,
  computeTokenUsageStats,
  formatCalendarTooltipText,
  formatCompactTokens,
  formatStreakDays,
  getAvailableCalendarYears,
  toLocalDateKey,
} from '../src/core/tokenUsage.ts';

test('formatCompactTokens formats small, k, M, and B values cleanly', () => {
  assert.equal(formatCompactTokens(0), '0');
  assert.equal(formatCompactTokens(842), '842');
  assert.equal(formatCompactTokens(1000), '1k');
  assert.equal(formatCompactTokens(34100), '34.1k');
  assert.equal(formatCompactTokens(34120), '34.1k');
  assert.equal(formatCompactTokens(999_950), '1M');
  assert.equal(formatCompactTokens(1_250_000), '1.3M');
});

test('formatCalendarTooltipText matches GitHub-style daily token phrasing', () => {
  const nov25 = new Date(2026, 10, 25);
  assert.equal(
    formatCalendarTooltipText(34100, nov25),
    '34.1k tokens used on November 25th.',
  );
  assert.equal(
    formatCalendarTooltipText(0, nov25),
    'No tokens used on November 25th.',
  );
  assert.equal(
    formatCalendarTooltipText(1200, new Date(2025, 0, 1), true),
    '1.2k tokens used on January 1st, 2025.',
  );
});

test('addTokenUsage and buildTokenCalendarGrid accumulate daily and lifetime totals accurately', () => {
  const nov25Ms = new Date(2026, 10, 25, 14, 30, 0).getTime();
  const nov26Ms = new Date(2026, 10, 26, 9, 15, 0).getTime();

  let usage = addTokenUsage(undefined, 34100, nov25Ms);
  usage = addTokenUsage(usage, 900, nov26Ms);

  assert.equal(usage.totalLifetimeTokens, 35000);
  assert.equal(usage.dailyTokens['2026-11-25'], 34100);
  assert.equal(usage.dailyTokens['2026-11-26'], 900);

  const grid = buildTokenCalendarGrid(usage.dailyTokens, 2026, new Date(2026, 10, 26));
  assert.equal(grid.totalTokensInRange, 35000);
  assert.equal(grid.activeDaysCount, 2);
  assert.equal(grid.maxDailyTokens, 34100);
  assert.ok(grid.weeks.length >= 52);

  const flat = grid.weeks.flat();
  const day25 = flat.find((c) => c.dateKey === '2026-11-25');
  const day26 = flat.find((c) => c.dateKey === '2026-11-26');
  assert.equal(day25?.level, 4);
  assert.equal(day26?.level, 1);

  const years = getAvailableCalendarYears(
    { ...usage.dailyTokens, '2024-05-10': 500 },
    new Date(2026, 10, 26),
  );
  assert.deepEqual(years, [2026, 2025, 2024]);
  assert.ok(grid.monthLabels.some((m) => m.label === 'Dec'));
});

test('backfillTokenUsageFromSessions recovers token history from existing sessions', () => {
  const ws = createDefaultWorkspace();
  const ts = new Date(2026, 10, 20, 10, 0, 0).getTime();
  ws.sessions[0].messages.push({
    id: 'm1',
    role: 'assistant',
    authorName: 'LowCon',
    createdAt: ts,
    content: 'Hello',
    sources: [],
    tokenCount: 150,
    turnBudget: {
      totalLimit: 8192,
      segments: [
        { key: 'core', name: 'Core', description: '', tokens: 250, color: '#000', isHeld: false, isFree: false },
        { key: 'free', name: 'Free', description: '', tokens: 7000, color: '#eee', isHeld: false, isFree: true },
        { key: 'out', name: 'Out', description: '', tokens: 942, color: '#ccc', isHeld: true, isFree: false },
      ],
    },
  });

  const backfilled = backfillTokenUsageFromSessions(ws.sessions);
  assert.equal(backfilled.totalLifetimeTokens, 400);
  assert.equal(backfilled.dailyTokens['2026-11-20'], 400);
});

test('userProfile and tokenUsage persist across unsealed storage and encrypted vault seal/unseal', async () => {
  const store = new Map<string, string>();
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  });

  const logger = new DiagnosticLogger('disabled');
  try {
    clearActiveVaultKey();
    const ws = createDefaultWorkspace();
    ws.settings.userProfile = {
      username: 'Alex',
      customSystemPrompt: 'Always respond with concise bullet points.',
    };
    ws.tokenUsage = addTokenUsage(ws.tokenUsage, 34100, new Date(2026, 10, 25).getTime());

    assert.equal(saveUnsealedWorkspace(ws, logger).ok, true);
    const reloaded = loadUnsealedWorkspace(logger);
    assert.equal(reloaded.workspace.settings.userProfile?.username, 'Alex');
    assert.equal(
      reloaded.workspace.settings.userProfile?.customSystemPrompt,
      'Always respond with concise bullet points.',
    );
    assert.equal(reloaded.workspace.tokenUsage?.totalLifetimeTokens, 34100);

    const sealed = await sealWorkspaceVault(reloaded.workspace, 'VaultPass#2026', logger);
    assert.equal(sealed.ok, true);
    const unsealed = await unsealWorkspaceVault('VaultPass#2026', logger);
    assert.equal(unsealed.ok, true);
    if (unsealed.ok) {
      assert.equal(unsealed.workspace.settings.userProfile?.username, 'Alex');
      assert.equal(
        unsealed.workspace.settings.userProfile?.customSystemPrompt,
        'Always respond with concise bullet points.',
      );
      assert.equal(unsealed.workspace.tokenUsage?.totalLifetimeTokens, 34100);
      assert.equal(unsealed.workspace.tokenUsage?.dailyTokens['2026-11-25'], 34100);
    }
  } finally {
    clearActiveVaultKey();
    if (prevStorage) {
      Object.defineProperty(globalThis, 'localStorage', prevStorage);
    }
  }
});

test('SidebarNav replaces Local boundary active with Profile trigger and ProfileView renders calendar and controls', () => {
  const ws = createDefaultWorkspace();
  const sidebarHtml = renderToStaticMarkup(
    React.createElement(SidebarNav, {
      currentTab: 'profile',
      onSelectTab: () => {},
      sessions: ws.sessions,
      activeSessionId: ws.activeSessionId,
      generatingSessionId: null,
      onSelectSession: () => {},
      onNewSession: () => {},
      onDeleteSession: () => {},
      username: 'Alex',
      totalLifetimeTokens: 34100,
    }),
  );

  assert.equal(sidebarHtml.includes('Local boundary active'), false);
  assert.ok(sidebarHtml.includes('data-testid="sidebar-profile-button"'));
  assert.ok(sidebarHtml.includes('Alex'));
  assert.ok(sidebarHtml.includes('34.1k tokens lifetime'));

  const today = new Date();
  const todayKey = toLocalDateKey(today);
  const profileHtml = renderToStaticMarkup(
    React.createElement(ProfileView, {
      profile: {
        username: 'Alex',
        customSystemPrompt: 'Be concise and technical.',
      },
      tokenUsage: {
        totalLifetimeTokens: 128400,
        dailyTokens: {
          [todayKey]: 34100,
        },
      },
      onUpdateProfile: () => {},
    }),
  );

  assert.ok(profileHtml.includes('data-testid="profile-username-input"'));
  assert.ok(profileHtml.includes('data-testid="profile-system-prompt-input"'));
  assert.ok(profileHtml.includes('data-testid="lifetime-tokens-value"'));
  assert.ok(profileHtml.includes('128.4k'));
  assert.ok(profileHtml.includes('lifetime tokens'));
  assert.ok(profileHtml.includes('data-testid="peak-day-tokens-value"'));
  assert.ok(profileHtml.includes('peak day'));
  assert.ok(profileHtml.includes('data-testid="current-streak-value"'));
  assert.ok(profileHtml.includes('current streak'));
  assert.ok(profileHtml.includes('data-testid="longest-streak-value"'));
  assert.ok(profileHtml.includes('longest streak'));
  assert.ok(profileHtml.includes('1 day'));
  assert.ok(profileHtml.includes(`data-testid="calendar-day-${todayKey}"`));
  assert.ok(profileHtml.includes('34.1k tokens used on '));

  // Verify contribution CSS variables exist for all presets
  for (const preset of THEME_PRESETS) {
    const computed = computeThemeCssVariables(preset.colors);
    for (let lvl = 0; lvl <= 4; lvl++) {
      assert.ok(computed.vars[`--lc-contrib-${lvl}`]);
    }
  }
});

test('computeTokenUsageStats and buildRecentTokenHeatmapGrid compute peak day, streaks, and 26-week grid accurately', () => {
  const now = new Date(2026, 10, 26); // Thu Nov 26, 2026
  const usage = {
    totalLifetimeTokens: 435_300_000,
    dailyTokens: {
      // Earlier 5-day streak
      '2026-10-01': 1_200_000,
      '2026-10-02': 2_500_000,
      '2026-10-03': 3_100_000,
      '2026-10-04': 57_100_000,
      '2026-10-05': 900_000,
      // Current 8-day streak ending today (Nov 19..Nov 26)
      '2026-11-19': 4_000_000,
      '2026-11-20': 12_000_000,
      '2026-11-21': 8_000_000,
      '2026-11-22': 19_000_000,
      '2026-11-23': 25_000_000,
      '2026-11-24': 14_000_000,
      '2026-11-25': 33_000_000,
      '2026-11-26': 41_000_000,
    },
  };

  const stats = computeTokenUsageStats(usage, now);
  assert.equal(stats.lifetimeTokens, 435_300_000);
  assert.equal(stats.peakDayTokens, 57_100_000);
  assert.equal(stats.peakDayDateKey, '2026-10-04');
  assert.equal(stats.currentStreakDays, 8);
  assert.equal(stats.longestStreakDays, 8);
  assert.equal(formatStreakDays(stats.currentStreakDays), '8 days');
  assert.equal(formatStreakDays(1), '1 day');
  assert.equal(formatStreakDays(0), '0 days');

  // Active streak remains alive if yesterday had usage and today has 0 so far
  const yesterdayStats = computeTokenUsageStats(
    {
      totalLifetimeTokens: 1000,
      dailyTokens: { '2026-11-24': 400, '2026-11-25': 600 },
    },
    now,
  );
  assert.equal(yesterdayStats.currentStreakDays, 2);
  assert.equal(yesterdayStats.longestStreakDays, 2);

  // Broken streak returns 0 current while keeping longest
  const brokenStats = computeTokenUsageStats(
    {
      totalLifetimeTokens: 1000,
      dailyTokens: { '2026-11-20': 400, '2026-11-21': 600 },
    },
    now,
  );
  assert.equal(brokenStats.currentStreakDays, 0);
  assert.equal(brokenStats.longestStreakDays, 2);

  // 26-week grid has exactly 26 columns x 7 rows, future days after Thu Nov 26 are out of range
  const grid = buildRecentTokenHeatmapGrid(usage.dailyTokens, 26, now);
  assert.equal(grid.weeks.length, 26);
  assert.ok(grid.weeks.every((w) => w.length === 7));
  const lastWeek = grid.weeks[25];
  assert.equal(lastWeek[4].dateKey, '2026-11-26');
  assert.equal(lastWeek[4].inRange, true);
  assert.equal(lastWeek[5].inRange, false); // Fri Nov 27 (future)
  assert.equal(lastWeek[6].inRange, false); // Sat Nov 28 (future)
});

test('generateDeterministicMockReply addresses user by profile username and acknowledges custom system prompt', () => {
  const reply = generateDeterministicMockReply('', [
    {
      role: 'system',
      content:
        'You are LowCon.\n\n[User Profile]\nThe user\'s name is "Alex". Address them by this name when appropriate.\n\n[Custom System Prompt]\nBe concise.',
    },
    { role: 'user', content: 'Hello!' },
  ]);

  assert.ok(reply.includes('Alex'));
  assert.ok(reply.includes('custom system prompt was applied'));
});
