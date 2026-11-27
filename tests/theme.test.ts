import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isNearScrollbarEdge,
  SCROLL_PROXIMITY_PX,
} from '../src/core/scrollbarProximity.ts';
import {
  computeThemeCssVariables,
  createDefaultTheme,
  getTpsColorVar,
  getTpsTier,
  isDarkColor,
  THEME_PRESETS,
} from '../src/core/theme.ts';

test('theme presets cover white, gray, and black with appropriate light/dark modes', () => {
  const byId = Object.fromEntries(THEME_PRESETS.map((p) => [p.id, p]));
  assert.ok(byId.white);
  assert.ok(byId.gray);
  assert.ok(byId.black);

  const whiteVars = computeThemeCssVariables(byId.white.colors);
  assert.equal(whiteVars.mode, 'light');
  assert.equal(isDarkColor(whiteVars.vars['--lc-code-bg']), false);
  assert.equal(isDarkColor(whiteVars.vars['--lc-code-text']), true);

  const grayVars = computeThemeCssVariables(byId.gray.colors);
  assert.equal(grayVars.mode, 'dark');
  assert.equal(isDarkColor(grayVars.vars['--lc-code-bg']), true);
  assert.equal(isDarkColor(grayVars.vars['--lc-code-text']), false);

  const blackVars = computeThemeCssVariables(byId.black.colors);
  assert.equal(blackVars.mode, 'dark');
  assert.equal(isDarkColor(blackVars.vars['--lc-bg']), true);
  assert.equal(isDarkColor(blackVars.vars['--lc-code-text']), false);
});

test('custom theme normalizes hex values and falls back cleanly on invalid input', () => {
  const defaults = createDefaultTheme();
  const custom = computeThemeCssVariables({
    bg: '#123',
    surface: 'not-a-color',
    sidebar: '#1c1f26',
    accent: '#ff5500',
  });

  assert.equal(custom.vars['--lc-bg'], '#112233');
  assert.equal(custom.vars['--lc-surface'], defaults.surface);
  assert.equal(custom.vars['--lc-side'], '#1C1F26');
  assert.equal(custom.vars['--lc-accent'], '#FF5500');
  assert.equal(custom.mode, 'dark');
});

test('tokens per second tiers map slow->red, orange, yellow, fast->green', () => {
  assert.equal(getTpsTier(0.5), 'red');
  assert.equal(getTpsTier(9.9), 'red');
  assert.equal(getTpsTier(10), 'orange');
  assert.equal(getTpsTier(24.9), 'orange');
  assert.equal(getTpsTier(25), 'yellow');
  assert.equal(getTpsTier(49.9), 'yellow');
  assert.equal(getTpsTier(50), 'green');
  assert.equal(getTpsTier(140), 'green');

  assert.equal(getTpsColorVar(4), 'var(--lc-tps-red)');
  assert.equal(getTpsColorVar(18), 'var(--lc-tps-orange)');
  assert.equal(getTpsColorVar(35), 'var(--lc-tps-yellow)');
  assert.equal(getTpsColorVar(85), 'var(--lc-tps-green)');

  const lightVars = computeThemeCssVariables(THEME_PRESETS[0].colors).vars;
  const darkVars = computeThemeCssVariables(THEME_PRESETS[2].colors).vars;
  for (const key of ['--lc-tps-red', '--lc-tps-orange', '--lc-tps-yellow', '--lc-tps-green']) {
    assert.ok(lightVars[key]);
    assert.ok(darkVars[key]);
  }
});

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test('codeMode decouples from dark bg and all semantic token pairs maintain >= 4.5:1 contrast', () => {
  const mixed = computeThemeCssVariables({
    bg: '#11141A',
    surface: '#FFFFFF',
    sidebar: '#181C24',
    accent: '#FACC15',
  });
  assert.equal(mixed.mode, 'dark');
  assert.equal(mixed.codeMode, 'light');
  assert.equal(isDarkColor(mixed.vars['--lc-code-bg']), false);
  assert.equal(isDarkColor(mixed.vars['--lc-code-text']), true);

  const themesToCheck = [
    ...THEME_PRESETS.map((p) => ({ name: p.id, computed: computeThemeCssVariables(p.colors) })),
    { name: 'mixed-dark-bg-light-surface', computed: mixed },
    {
      name: 'mixed-light-bg-dark-surface',
      computed: computeThemeCssVariables({
        bg: '#F8FAFC',
        surface: '#161A22',
        sidebar: '#EEF2F7',
        accent: '#0EA5E9',
      }),
    },
  ];

  for (const { name, computed } of themesToCheck) {
    const v = computed.vars;
    assert.ok(
      contrastRatio(v['--lc-success-contrast'], v['--lc-success']) >= 4.5,
      `${name}: --lc-success-contrast on --lc-success`,
    );
    assert.ok(
      contrastRatio(v['--lc-danger-contrast'], v['--lc-danger']) >= 4.5,
      `${name}: --lc-danger-contrast on --lc-danger`,
    );
    assert.ok(
      contrastRatio(v['--lc-panel-ink'], v['--lc-panel']) >= 4.5,
      `${name}: --lc-panel-ink on --lc-panel`,
    );
    assert.ok(
      contrastRatio(v['--lc-surf-active-fg'], v['--lc-surf-active-bg']) >= 4.5,
      `${name}: --lc-surf-active-fg on --lc-surf-active-bg`,
    );
    assert.ok(
      contrastRatio(v['--lc-code-text'], v['--lc-code-bg']) >= 4.5,
      `${name}: --lc-code-text on --lc-code-bg`,
    );
    for (const callout of ['note', 'tip', 'important', 'warning', 'caution']) {
      assert.ok(
        contrastRatio(v[`--lc-callout-${callout}`], v['--lc-bg']) >= 4.5,
        `${name}: --lc-callout-${callout} on --lc-bg`,
      );
    }
    assert.ok(v['--lc-scroll-thumb']);
    assert.ok(v['--lc-scroll-thumb-hover']);
  }
});

test('isNearScrollbarEdge reveals scrollbars only when pointer is close to scrollable edges', () => {
  const rect = { left: 100, right: 500, top: 50, bottom: 450 };

  // Far from vertical/horizontal scrollbar edges -> hidden
  assert.equal(isNearScrollbarEdge(rect, 250, 200, true, false), false);
  assert.equal(
    isNearScrollbarEdge(rect, 500 - SCROLL_PROXIMITY_PX - 5, 200, true, false),
    false,
  );

  // Close to right vertical scrollbar -> revealed
  assert.equal(
    isNearScrollbarEdge(rect, 500 - SCROLL_PROXIMITY_PX + 2, 200, true, false),
    true,
  );
  assert.equal(isNearScrollbarEdge(rect, 498, 200, true, false), true);

  // Close to bottom horizontal scrollbar when horizontal scrolling exists -> revealed
  assert.equal(isNearScrollbarEdge(rect, 250, 440, false, true), true);
  assert.equal(isNearScrollbarEdge(rect, 250, 440, true, false), false);
});
