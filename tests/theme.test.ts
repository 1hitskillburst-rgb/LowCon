import test from 'node:test';
import assert from 'node:assert/strict';
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
