import React, { useState } from 'react';
import { Lock, Palette, RefreshCw, ShieldCheck, Sparkles, Terminal, Trash2 } from 'lucide-react';
import { calculateBudgetPartition } from '../../core/context';
import { formatNumber } from '../../core/privacy';
import { DEFAULT_PROMPT_EFFORT_PROMPTS } from '../../core/storage';
import { createDefaultTheme, THEME_PRESETS } from '../../core/theme';
import {
  getEffectiveContextLimit,
  type AppSettings,
  type BackendType,
  type ChatWidthPreset,
  type DiagnosticEntry,
  type DiagnosticLevel,
  type EffortLevel,
  type ModelProfile,
  type ThemeSettings,
} from '../../core/types';

interface SettingsViewProps {
  settings: AppSettings;
  activeModel?: ModelProfile;
  diagnosticEntries: DiagnosticEntry[];
  isTestingConnection: boolean;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onSwitchBackend: (backend: BackendType) => void;
  onTestLmStudioConnection: () => Promise<void>;
  onSelectLmModel: (modelName: string) => void;
  onLockVault: (passphrase: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onClearDiagnostics: () => void;
}

const CONTEXT_PRESETS = [
  { label: '2K', value: 2048 },
  { label: '4K', value: 4096 },
  { label: '8K', value: 8192 },
  { label: '16K', value: 16384 },
  { label: '32K', value: 32768 },
  { label: '64K', value: 65536 },
  { label: '128K', value: 131072 },
] as const;

const CHAT_WIDTH_OPTIONS: Array<{ id: ChatWidthPreset; label: string; hint: string }> = [
  { id: 'default', label: 'Standard', hint: '660px' },
  { id: 'medium', label: 'Medium', hint: '840px' },
  { id: 'wide', label: 'Wide', hint: '1060px' },
  { id: 'fill', label: 'Fill', hint: 'Edge to edge' },
];

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  activeModel,
  diagnosticEntries,
  isTestingConnection,
  onUpdateSettings,
  onSwitchBackend,
  onTestLmStudioConnection,
  onSelectLmModel,
  onLockVault,
  onClearDiagnostics,
}) => {
  const [vaultPassphrase, setVaultPassphrase] = useState('');
  const [vaultConfirm, setVaultConfirm] = useState('');
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [isSealing, setIsSealing] = useState(false);

  const currentTheme: ThemeSettings = settings.theme ?? createDefaultTheme();
  const effectivePreviewLimit = getEffectiveContextLimit(
    activeModel,
    settings.contextLimitOverride,
  );
  const modelCap = activeModel ? (activeModel.contextOverride ?? activeModel.contextLimit) : null;

  const previewPartition = calculateBudgetPartition(
    effectivePreviewLimit,
    settings.outputReservePct,
    settings.safetyMarginPct,
  );

  const handleApplyPreset = (presetId: 'white' | 'gray' | 'black') => {
    const found = THEME_PRESETS.find((p) => p.id === presetId);
    if (!found) return;
    onUpdateSettings({
      theme: {
        preset: found.id,
        ...found.colors,
      },
    });
  };

  const handleThemeColorChange = (
    key: keyof Omit<ThemeSettings, 'preset'>,
    value: string,
  ) => {
    onUpdateSettings({
      theme: {
        ...currentTheme,
        preset: 'custom',
        [key]: value.toUpperCase(),
      },
    });
  };

  const handleLockVaultSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setVaultError(null);
    if (vaultPassphrase.length < 4) {
      setVaultError('Enter a passphrase of at least 4 characters to seal the local vault.');
      return;
    }
    if (vaultPassphrase !== vaultConfirm) {
      setVaultError('Passphrase confirmation does not match.');
      return;
    }
    setIsSealing(true);
    const res = await onLockVault(vaultPassphrase);
    setIsSealing(false);
    if (!res.ok) {
      setVaultError(res.error);
    } else {
      setVaultPassphrase('');
      setVaultConfirm('');
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--lc-bg)] text-[var(--lc-ink)]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--lc-line)] px-7 py-3">
        <div className="flex items-center text-[13px]">
          <span className="text-[var(--lc-mute)]">Workspace /</span>
          <span className="ml-1 font-semibold text-[var(--lc-ink)]">Settings</span>
        </div>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[780px] space-y-5 pb-8">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight text-[var(--lc-ink)]">
              Workbench Settings & Local Security
            </h1>
            <p className="mt-1 text-[13.5px] text-[var(--lc-ink2)]">
              All configuration persists locally in this workspace and is respected immediately by
              the theme, context packer, inference worker, and encrypted storage vault.
            </p>
          </div>

          {/* 1. Appearance & Theme */}
          <section className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-5 text-[var(--lc-surf-ink)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Palette className="h-4 w-4 text-[var(--lc-surf-ink)]" />
                <h2 className="text-[15px] font-bold text-[var(--lc-surf-ink)]">
                  Appearance & Theme
                </h2>
              </div>

              <div className="flex items-center gap-1.5" role="group" aria-label="Theme presets">
                {THEME_PRESETS.map((preset) => {
                  const isActive = currentTheme.preset === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      data-testid={`theme-preset-${preset.id}`}
                      onClick={() => handleApplyPreset(preset.id)}
                      className={`inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                        isActive
                          ? 'border-[var(--lc-accent)] bg-[var(--lc-accent)] text-[var(--lc-accent-contrast)]'
                          : 'border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink)] hover:bg-[var(--lc-surf-hover)]'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        style={{ backgroundColor: preset.colors.bg }}
                        className="h-3 w-3 rounded-full border border-black/20"
                      />
                      <span>{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <p className="mt-1 text-[12.5px] text-[var(--lc-surf-mute)]">
              Quickly switch to White, Gray, or Black, or fine-tune core workspace colors. Text and
              code-block contrast adjust automatically.
            </p>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  { key: 'bg', label: 'Background', id: 'theme-color-bg' },
                  { key: 'surface', label: 'Cards & Inputs', id: 'theme-color-surface' },
                  { key: 'sidebar', label: 'Sidebars', id: 'theme-color-sidebar' },
                  { key: 'accent', label: 'Accent', id: 'theme-color-accent' },
                ] as const
              ).map((item) => (
                <label
                  key={item.key}
                  htmlFor={item.id}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-bg)]/50 px-2.5 py-2 text-[12px]"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-[var(--lc-surf-ink)]">{item.label}</div>
                    <div className="font-mono text-[11px] text-[var(--lc-surf-mute)]">
                      {currentTheme[item.key]}
                    </div>
                  </div>
                  <input
                    id={item.id}
                    type="color"
                    value={currentTheme[item.key]}
                    onChange={(e) => handleThemeColorChange(item.key, e.target.value)}
                    className="h-7 w-7 shrink-0 cursor-pointer rounded border border-[var(--lc-surf-line)] bg-transparent p-0"
                  />
                </label>
              ))}
            </div>

            <div className="mt-4 border-t border-[var(--lc-line-soft)] pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[13px] font-semibold text-[var(--lc-surf-ink)]">
                    Chat &amp; Composer Width
                  </div>
                  <p className="text-[12px] text-[var(--lc-surf-mute)]">
                    Choose how wide the chat messages and input box stretch between the left
                    sidebar and right token panel.
                  </p>
                </div>
              </div>

              <div
                className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4"
                role="group"
                aria-label="Chat width presets"
              >
                {CHAT_WIDTH_OPTIONS.map((opt) => {
                  const activeWidth = settings.chatWidth ?? 'default';
                  const isActive = activeWidth === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      data-testid={`chat-width-${opt.id}`}
                      onClick={() => onUpdateSettings({ chatWidth: opt.id })}
                      className={`rounded-[6px] border px-3 py-2 text-left transition-colors ${
                        isActive
                          ? 'border-[var(--lc-accent)] bg-[var(--lc-accent)] text-[var(--lc-accent-contrast)]'
                          : 'border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink)] hover:bg-[var(--lc-surf-hover)]'
                      }`}
                    >
                      <div className="text-[12.5px] font-semibold">{opt.label}</div>
                      <div
                        className={`text-[11px] ${
                          isActive ? 'opacity-85' : 'text-[var(--lc-surf-mute)]'
                        }`}
                      >
                        {opt.hint}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          {/* 2. Local Inference Backend & LM Studio */}
          <section className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-5 text-[var(--lc-surf-ink)]">
            <h2 className="text-[15px] font-bold text-[var(--lc-surf-ink)]">
              Local Inference Backend & LM Studio Server
            </h2>
            <p className="mt-1 text-[12.5px] text-[var(--lc-surf-mute)]">
              Switch between the deterministic in-process mock backend and a local loopback
              OpenAI-compatible server (LM Studio / llama.cpp).
            </p>

            <div className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <label
                className={`flex cursor-pointer items-start gap-2.5 rounded-[7px] border p-3 ${
                  settings.activeBackendType === 'mock'
                    ? 'border-[var(--lc-accent)] bg-[var(--lc-panel)]'
                    : 'border-[var(--lc-surf-line)] bg-[var(--lc-surface)] hover:bg-[var(--lc-surf-hover)]'
                }`}
              >
                <input
                  type="radio"
                  name="active-backend"
                  checked={settings.activeBackendType === 'mock'}
                  onChange={() => onSwitchBackend('mock')}
                  className="mt-0.5 accent-[var(--lc-accent)]"
                />
                <div>
                  <div className="text-[13.5px] font-semibold text-[var(--lc-surf-ink)]">
                    Offline Mock Harness
                  </div>
                  <div className="text-[12px] text-[var(--lc-surf-ink2)]">
                    Zero external dependencies. Verifies context packing and streaming locally.
                  </div>
                </div>
              </label>

              <label
                className={`flex cursor-pointer items-start gap-2.5 rounded-[7px] border p-3 ${
                  settings.activeBackendType === 'lm_studio'
                    ? 'border-[var(--lc-accent)] bg-[var(--lc-panel)]'
                    : 'border-[var(--lc-surf-line)] bg-[var(--lc-surface)] hover:bg-[var(--lc-surf-hover)]'
                }`}
              >
                <input
                  type="radio"
                  name="active-backend"
                  checked={settings.activeBackendType === 'lm_studio'}
                  onChange={() => onSwitchBackend('lm_studio')}
                  className="mt-0.5 accent-[var(--lc-accent)]"
                />
                <div>
                  <div className="text-[13.5px] font-semibold text-[var(--lc-surf-ink)]">
                    LM Studio / Local Server
                  </div>
                  <div className="text-[12px] text-[var(--lc-surf-ink2)]">
                    Streams structured chat messages via loopback proxy (no double-templating).
                  </div>
                </div>
              </label>
            </div>

            <div className="mt-4 space-y-3 border-t border-[var(--lc-line-soft)] pt-4">
              <div>
                <label
                  htmlFor="lm-endpoint-input"
                  className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]"
                >
                  Local Loopback Endpoint (127.0.0.1 / localhost / ::1 only)
                </label>
                <div className="mt-1 flex flex-wrap gap-2">
                  <input
                    id="lm-endpoint-input"
                    type="text"
                    value={settings.lmStudioEndpoint}
                    onChange={(e) => onUpdateSettings({ lmStudioEndpoint: e.target.value })}
                    className="min-w-[260px] flex-1 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 font-mono text-[12.5px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={isTestingConnection}
                    onClick={() => void onTestLmStudioConnection()}
                    className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3.5 py-1.5 text-[12.5px] font-semibold text-[var(--lc-surf-ink)] hover:bg-[var(--lc-surf-hover)] disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isTestingConnection ? 'animate-spin' : ''}`} />
                    <span>
                      {isTestingConnection ? 'Testing...' : 'Test Connection & Fetch Models'}
                    </span>
                  </button>
                </div>
                <div className="mt-1.5 text-[12px] text-[var(--lc-surf-ink2)]">
                  Status: <span className="font-medium text-[var(--lc-surf-ink)]">{settings.connectionStatus}</span>
                </div>
              </div>

              {settings.connectedLmModels.length > 0 && (
                <div>
                  <label
                    htmlFor="lm-model-select"
                    className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]"
                  >
                    Selected Server Model
                  </label>
                  <select
                    id="lm-model-select"
                    value={settings.selectedLmModel}
                    onChange={(e) => onSelectLmModel(e.target.value)}
                    className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[13px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                  >
                    {settings.connectedLmModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </section>

          {/* 2b. Reasoning & Prompt Effort */}
          <section className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-5 text-[var(--lc-surf-ink)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[var(--lc-surf-ink)]" />
                <h2 className="text-[15px] font-bold text-[var(--lc-surf-ink)]">
                  Prompt Effort (System Prompt Fallback)
                </h2>
              </div>

              <div className="flex items-center gap-2.5">
                <span className="text-[12px] font-medium text-[var(--lc-surf-ink2)]">
                  Prompt effort
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.promptEffortEnabled}
                  aria-label="Toggle prompt effort system prompt injection"
                  data-testid="prompt-effort-toggle"
                  onClick={() =>
                    onUpdateSettings({ promptEffortEnabled: !settings.promptEffortEnabled })
                  }
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    settings.promptEffortEnabled ? 'bg-[var(--lc-accent)]' : 'bg-[var(--lc-seg-tpl)]'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      settings.promptEffortEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    }`}
                  />
                </button>
              </div>
            </div>

            <p className="mt-1 text-[12.5px] text-[var(--lc-surf-mute)]">
              When enabled, models that ignore native <code>reasoning_effort</code> receive the
              active effort level&apos;s system prompt below. When disabled, LowCon forwards{' '}
              <code>reasoning_effort</code> directly to LM Studio.
            </p>

            <div className="mt-4 space-y-3">
              {(
                [
                  { id: 'low', label: 'Low' },
                  { id: 'medium', label: 'Medium' },
                  { id: 'high', label: 'High' },
                  { id: 'xhigh', label: 'Extra High (xhigh)' },
                ] as Array<{ id: EffortLevel; label: string }>
              ).map((lvl) => {
                const isActiveLevel = settings.effortLevel === lvl.id;
                return (
                  <div key={lvl.id}>
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor={`prompt-effort-${lvl.id}`}
                        className="text-[12px] font-semibold text-[var(--lc-surf-ink2)]"
                      >
                        {lvl.label}
                        {isActiveLevel && (
                          <span className="ml-2 rounded bg-[var(--lc-accent)]/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--lc-accent)]">
                            Active
                          </span>
                        )}
                      </label>
                    </div>
                    <textarea
                      id={`prompt-effort-${lvl.id}`}
                      rows={2}
                      value={settings.promptEffortPrompts[lvl.id]}
                      onChange={(e) =>
                        onUpdateSettings({
                          promptEffortPrompts: {
                            ...settings.promptEffortPrompts,
                            [lvl.id]: e.target.value,
                          },
                        })
                      }
                      className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[12.5px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                    />
                  </div>
                );
              })}

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() =>
                    onUpdateSettings({
                      promptEffortPrompts: { ...DEFAULT_PROMPT_EFFORT_PROMPTS },
                    })
                  }
                  className="rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]"
                >
                  Reset default prompts
                </button>
              </div>
            </div>
          </section>

          {/* 3. Context Budget Allocation */}
          <section className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-5 text-[var(--lc-surf-ink)]">
            <h2 className="text-[15px] font-bold text-[var(--lc-surf-ink)]">Context Budget Allocation</h2>
            <p className="mt-1 text-[12.5px] text-[var(--lc-surf-mute)]">
              Reply reserve and safety margin are held first on every turn. Output generation is
              strictly capped to the computed reply reserve.
            </p>

            <div className="mt-4 space-y-4">
              <div>
                <div className="flex items-center justify-between text-[13px]">
                  <label htmlFor="output-reserve-slider" className="font-medium text-[var(--lc-surf-ink)]">
                    Output Reply Reserve
                  </label>
                  <span
                    data-testid="output-reserve-value"
                    className="font-bold text-[var(--lc-accent)] tabular-nums"
                  >
                    {settings.outputReservePct}%
                  </span>
                </div>
                <input
                  id="output-reserve-slider"
                  type="range"
                  min={5}
                  max={50}
                  step={1}
                  value={settings.outputReservePct}
                  onChange={(e) => onUpdateSettings({ outputReservePct: Number(e.target.value) })}
                  className="mt-1.5 w-full accent-[var(--lc-accent)]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-[13px]">
                  <label htmlFor="safety-margin-slider" className="font-medium text-[var(--lc-surf-ink)]">
                    Overflow Safety Margin
                  </label>
                  <span
                    data-testid="safety-margin-value"
                    className="font-bold text-[var(--lc-accent)] tabular-nums"
                  >
                    {settings.safetyMarginPct}%
                  </span>
                </div>
                <input
                  id="safety-margin-slider"
                  type="range"
                  min={2}
                  max={25}
                  step={1}
                  value={settings.safetyMarginPct}
                  onChange={(e) => onUpdateSettings({ safetyMarginPct: Number(e.target.value) })}
                  className="mt-1.5 w-full accent-[var(--lc-accent)]"
                />
              </div>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                  <label htmlFor="context-limit-slider" className="font-medium text-[var(--lc-surf-ink)]">
                    Working Context Cap
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="context-limit-input"
                      aria-label="Working Context Cap exact tokens"
                      type="number"
                      min={256}
                      max={131072}
                      step={256}
                      value={settings.contextLimitOverride}
                      onChange={(e) => {
                        const parsed = Number(e.target.value);
                        if (Number.isFinite(parsed)) {
                          onUpdateSettings({
                            contextLimitOverride: Math.max(256, Math.min(131072, Math.round(parsed))),
                          });
                        }
                      }}
                      className="w-24 rounded-[5px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2 py-0.5 text-right font-mono text-[12.5px] font-bold text-[var(--lc-surf-ink)] tabular-nums focus:border-[var(--lc-accent)] focus:outline-none"
                    />
                    <span className="text-[12px] text-[var(--lc-surf-mute)]">tokens</span>
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Context token presets">
                  {CONTEXT_PRESETS.map((preset) => {
                    const isActive = settings.contextLimitOverride === preset.value;
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        data-testid={`ctx-preset-${preset.label}`}
                        onClick={() => onUpdateSettings({ contextLimitOverride: preset.value })}
                        className={`rounded-[5px] border px-2.5 py-0.5 text-[11.5px] font-semibold tabular-nums transition-colors ${
                          isActive
                            ? 'border-[var(--lc-accent)] bg-[var(--lc-accent)] text-[var(--lc-accent-contrast)]'
                            : 'border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>

                <input
                  id="context-limit-slider"
                  type="range"
                  min={512}
                  max={131072}
                  step={512}
                  value={Math.min(131072, settings.contextLimitOverride)}
                  onChange={(e) =>
                    onUpdateSettings({ contextLimitOverride: Number(e.target.value) })
                  }
                  className="mt-2 w-full accent-[var(--lc-accent)]"
                />

                {modelCap !== null && modelCap < settings.contextLimitOverride && (
                  <p className="mt-1 text-[11.5px] text-[var(--lc-warn)]">
                    Active model ({activeModel?.name}) is capped at {formatNumber(modelCap)} tokens
                    in Models, so effective context is {formatNumber(effectivePreviewLimit)} tokens.
                  </p>
                )}
              </div>

              {previewPartition.ok && (
                <div className="grid grid-cols-3 gap-3 rounded-[6px] border border-[var(--lc-line)] bg-[var(--lc-panel)] px-3.5 py-2.5 text-[12px] text-[var(--lc-side-ink)]">
                  <div>
                    <div className="text-[var(--lc-side-mute)]">Prompt Budget</div>
                    <div className="font-bold text-[var(--lc-side-ink)] tabular-nums">
                      {formatNumber(previewPartition.partition.promptBudget)} tok
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--lc-side-mute)]">Output Reserve (max_tokens)</div>
                    <div className="font-bold text-[var(--lc-side-ink)] tabular-nums">
                      {formatNumber(previewPartition.partition.outputReserve)} tok
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--lc-side-mute)]">Safety Margin</div>
                    <div className="font-bold text-[var(--lc-side-ink)] tabular-nums">
                      {formatNumber(previewPartition.partition.safetyMargin)} tok
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* 4. Encrypted Local Storage Vault */}
          <section className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-5 text-[var(--lc-surf-ink)]">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-[var(--lc-surf-ink)]" />
              <h2 className="text-[15px] font-bold text-[var(--lc-surf-ink)]">
                Encrypted Local Storage Vault (AES-256-GCM)
              </h2>
            </div>
            <p className="mt-1 text-[12.5px] text-[var(--lc-surf-mute)]">
              Seals your entire local workspace (sessions, memory notes, models, and settings) with
              PBKDF2-SHA256 (150,000 iterations) + AES-256-GCM authenticated encryption, purges
              plaintext storage, and locks the interface until unlocked with your passphrase.
            </p>
            <div className="mt-2 font-mono text-[11.5px] text-[var(--lc-surf-ink2)]">
              Storage: {settings.storageNamespace}
            </div>

            <form onSubmit={(e) => void handleLockVaultSubmit(e)} className="mt-3.5 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="vault-passphrase-input"
                    className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]"
                  >
                    Vault Passphrase
                  </label>
                  <input
                    id="vault-passphrase-input"
                    type="password"
                    autoComplete="new-password"
                    value={vaultPassphrase}
                    onChange={(e) => setVaultPassphrase(e.target.value)}
                    placeholder="Enter passphrase to seal"
                    className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[13px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="vault-confirm-input"
                    className="block text-[12px] font-semibold text-[var(--lc-surf-ink2)]"
                  >
                    Confirm Passphrase
                  </label>
                  <input
                    id="vault-confirm-input"
                    type="password"
                    autoComplete="new-password"
                    value={vaultConfirm}
                    onChange={(e) => setVaultConfirm(e.target.value)}
                    placeholder="Re-enter passphrase"
                    className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[13px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                  />
                </div>
              </div>

              {vaultError && (
                <div role="alert" className="text-[12.5px] font-medium text-[var(--lc-danger)]">
                  {vaultError}
                </div>
              )}

              <button
                type="submit"
                disabled={isSealing}
                className="inline-flex items-center gap-1.5 rounded-[6px] bg-[var(--lc-accent)] px-4 py-1.5 text-[13px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)] disabled:opacity-50"
              >
                <Lock className="h-3.5 w-3.5" />
                <span>{isSealing ? 'Sealing Vault...' : 'Lock Vault Now'}</span>
              </button>
            </form>
          </section>

          {/* 5. Local Diagnostic Logging Policy */}
          <section className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-5 text-[var(--lc-surf-ink)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-[var(--lc-surf-ink)]" />
                <h2 className="text-[15px] font-bold text-[var(--lc-surf-ink)]">
                  Local Redacted Diagnostic Logs
                </h2>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="diagnostic-level-select" className="sr-only">
                  Diagnostic logging level
                </label>
                <select
                  id="diagnostic-level-select"
                  value={settings.diagnosticLevel}
                  onChange={(e) =>
                    onUpdateSettings({ diagnosticLevel: e.target.value as DiagnosticLevel })
                  }
                  className="rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1 text-[12.5px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                >
                  <option value="disabled">Disabled</option>
                  <option value="minimal_redacted">Minimal Redacted</option>
                  <option value="debug_redacted">Debug Redacted</option>
                </select>
                <button
                  type="button"
                  onClick={onClearDiagnostics}
                  className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1 text-[12px] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>Clear</span>
                </button>
              </div>
            </div>

            <p className="mt-1 text-[12.5px] text-[var(--lc-surf-mute)]">
              Sensitive prompt content, passphrases, and auth tokens are automatically scrubbed
              before entries enter the in-memory ring buffer.
            </p>

            <div
              data-testid="diagnostic-log-viewer"
              className="mt-3 max-h-48 overflow-y-auto rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-bg)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--lc-ink)]"
            >
              {diagnosticEntries.length === 0 ? (
                <div className="italic text-[var(--lc-mute)]">
                  {settings.diagnosticLevel === 'disabled'
                    ? 'Diagnostic logging is disabled.'
                    : 'No diagnostic events recorded yet.'}
                </div>
              ) : (
                diagnosticEntries.map((entry) => (
                  <div key={entry.id} className="border-b border-[var(--lc-line-soft)] py-1 last:border-b-0">
                    <span className="text-[var(--lc-mute)]">
                      [{new Date(entry.timestamp).toLocaleTimeString()}]
                    </span>{' '}
                    <span
                      className={`font-semibold ${
                        entry.level === 'ERROR'
                          ? 'text-[var(--lc-danger)]'
                          : entry.level === 'WARN'
                            ? 'text-[var(--lc-warn)]'
                            : 'text-[var(--lc-success)]'
                      }`}
                    >
                      {entry.level}
                    </span>{' '}
                    <span className="text-[var(--lc-accent)]">[{entry.module}]</span>{' '}
                    <span className="text-[var(--lc-ink)]">{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 6. Privacy & Network Boundary */}
          <section className="rounded-[8px] border border-[var(--lc-line)] bg-[var(--lc-panel)] p-5 text-[var(--lc-side-ink)]">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[var(--lc-success)]" />
              <h2 className="text-[14.5px] font-bold text-[var(--lc-side-ink)]">
                Local Privacy & Loopback Boundary
              </h2>
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--lc-side-ink2)]">
              LowCon makes zero remote cloud LLM calls, embeds zero analytics or telemetry SDKs, and
              enforces strict loopback validation (<code>127.0.0.1</code>, <code>localhost</code>,{' '}
              <code>::1</code>) on both client and local server proxy layers before forwarding any
              optional LM Studio HTTP request.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
};
