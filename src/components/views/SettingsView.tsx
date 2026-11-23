import React, { useState } from 'react';
import { Lock, RefreshCw, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
import { calculateBudgetPartition } from '../../core/context';
import { formatNumber } from '../../core/privacy';
import type { AppSettings, BackendType, DiagnosticEntry, DiagnosticLevel } from '../../core/types';

interface SettingsViewProps {
  settings: AppSettings;
  diagnosticEntries: DiagnosticEntry[];
  isTestingConnection: boolean;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onSwitchBackend: (backend: BackendType) => void;
  onTestLmStudioConnection: () => Promise<void>;
  onSelectLmModel: (modelName: string) => void;
  onLockVault: (passphrase: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onClearDiagnostics: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
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

  const previewPartition = calculateBudgetPartition(
    settings.contextLimitOverride,
    settings.outputReservePct,
    settings.safetyMarginPct,
  );

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
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[#F7F8F9]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-[#D3D8DF] px-7 py-3">
        <div className="flex items-center text-[13px]">
          <span className="text-[#778091]">Workspace /</span>
          <span className="ml-1 font-semibold text-[#161B26]">Settings</span>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[780px] space-y-5 pb-8">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight text-[#161B26]">
              Workbench Settings & Local Security
            </h1>
            <p className="mt-1 text-[13.5px] text-[#444D5C]">
              All configuration persists locally in this workspace and is respected immediately by
              the context packer, inference worker, and encrypted storage vault.
            </p>
          </div>

          {/* 1. Local Inference Backend & LM Studio */}
          <section className="rounded-[8px] border border-[#D3D8DF] bg-white p-5">
            <h2 className="text-[15px] font-bold text-[#161B26]">
              Local Inference Backend & LM Studio Server
            </h2>
            <p className="mt-1 text-[12.5px] text-[#778091]">
              Switch between the deterministic in-process mock backend and a local loopback
              OpenAI-compatible server (LM Studio / llama.cpp).
            </p>

            <div className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <label
                className={`flex cursor-pointer items-start gap-2.5 rounded-[7px] border p-3 ${
                  settings.activeBackendType === 'mock'
                    ? 'border-[#161B26] bg-[#EEF0F3]'
                    : 'border-[#D3D8DF] bg-white hover:bg-[#F7F8F9]'
                }`}
              >
                <input
                  type="radio"
                  name="active-backend"
                  checked={settings.activeBackendType === 'mock'}
                  onChange={() => onSwitchBackend('mock')}
                  className="mt-0.5 accent-[#2A3FE0]"
                />
                <div>
                  <div className="text-[13.5px] font-semibold text-[#161B26]">
                    Offline Mock Harness
                  </div>
                  <div className="text-[12px] text-[#444D5C]">
                    Zero external dependencies. Verifies context packing and streaming locally.
                  </div>
                </div>
              </label>

              <label
                className={`flex cursor-pointer items-start gap-2.5 rounded-[7px] border p-3 ${
                  settings.activeBackendType === 'lm_studio'
                    ? 'border-[#161B26] bg-[#EEF0F3]'
                    : 'border-[#D3D8DF] bg-white hover:bg-[#F7F8F9]'
                }`}
              >
                <input
                  type="radio"
                  name="active-backend"
                  checked={settings.activeBackendType === 'lm_studio'}
                  onChange={() => onSwitchBackend('lm_studio')}
                  className="mt-0.5 accent-[#2A3FE0]"
                />
                <div>
                  <div className="text-[13.5px] font-semibold text-[#161B26]">
                    LM Studio / Local Server
                  </div>
                  <div className="text-[12px] text-[#444D5C]">
                    Streams structured chat messages via loopback proxy (no double-templating).
                  </div>
                </div>
              </label>
            </div>

            <div className="mt-4 space-y-3 border-t border-[#E8EBEF] pt-4">
              <div>
                <label
                  htmlFor="lm-endpoint-input"
                  className="block text-[12px] font-semibold text-[#444D5C]"
                >
                  Local Loopback Endpoint (127.0.0.1 / localhost / ::1 only)
                </label>
                <div className="mt-1 flex flex-wrap gap-2">
                  <input
                    id="lm-endpoint-input"
                    type="text"
                    value={settings.lmStudioEndpoint}
                    onChange={(e) => onUpdateSettings({ lmStudioEndpoint: e.target.value })}
                    className="min-w-[260px] flex-1 rounded-[6px] border border-[#D3D8DF] px-3 py-1.5 font-mono text-[12.5px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={isTestingConnection}
                    onClick={() => void onTestLmStudioConnection()}
                    className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#161B26] bg-white px-3.5 py-1.5 text-[12.5px] font-semibold text-[#161B26] hover:bg-[#DDE1E7] disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isTestingConnection ? 'animate-spin' : ''}`} />
                    <span>
                      {isTestingConnection ? 'Testing...' : 'Test Connection & Fetch Models'}
                    </span>
                  </button>
                </div>
                <div className="mt-1.5 text-[12px] text-[#444D5C]">
                  Status: <span className="font-medium text-[#161B26]">{settings.connectionStatus}</span>
                </div>
              </div>

              {settings.connectedLmModels.length > 0 && (
                <div>
                  <label
                    htmlFor="lm-model-select"
                    className="block text-[12px] font-semibold text-[#444D5C]"
                  >
                    Selected Server Model
                  </label>
                  <select
                    id="lm-model-select"
                    value={settings.selectedLmModel}
                    onChange={(e) => onSelectLmModel(e.target.value)}
                    className="mt-1 w-full rounded-[6px] border border-[#D3D8DF] bg-white px-3 py-1.5 text-[13px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
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

          {/* 2. Context Budget Allocation */}
          <section className="rounded-[8px] border border-[#D3D8DF] bg-white p-5">
            <h2 className="text-[15px] font-bold text-[#161B26]">Context Budget Allocation</h2>
            <p className="mt-1 text-[12.5px] text-[#778091]">
              Reply reserve and safety margin are held first on every turn. Output generation is
              strictly capped to the computed reply reserve.
            </p>

            <div className="mt-4 space-y-4">
              <div>
                <div className="flex items-center justify-between text-[13px]">
                  <label htmlFor="output-reserve-slider" className="font-medium text-[#161B26]">
                    Output Reply Reserve
                  </label>
                  <span
                    data-testid="output-reserve-value"
                    className="font-bold text-[#2A3FE0] tabular-nums"
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
                  className="mt-1.5 w-full accent-[#2A3FE0]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-[13px]">
                  <label htmlFor="safety-margin-slider" className="font-medium text-[#161B26]">
                    Overflow Safety Margin
                  </label>
                  <span
                    data-testid="safety-margin-value"
                    className="font-bold text-[#2A3FE0] tabular-nums"
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
                  className="mt-1.5 w-full accent-[#2A3FE0]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-[13px]">
                  <label htmlFor="context-limit-slider" className="font-medium text-[#161B26]">
                    Default Working Context Cap
                  </label>
                  <span className="font-bold text-[#161B26] tabular-nums">
                    {formatNumber(settings.contextLimitOverride)} tokens
                  </span>
                </div>
                <input
                  id="context-limit-slider"
                  type="range"
                  min={512}
                  max={32768}
                  step={512}
                  value={settings.contextLimitOverride}
                  onChange={(e) =>
                    onUpdateSettings({ contextLimitOverride: Number(e.target.value) })
                  }
                  className="mt-1.5 w-full accent-[#2A3FE0]"
                />
              </div>

              {previewPartition.ok && (
                <div className="grid grid-cols-3 gap-3 rounded-[6px] border border-[#D3D8DF] bg-[#EEF0F3] px-3.5 py-2.5 text-[12px]">
                  <div>
                    <div className="text-[#778091]">Prompt Budget</div>
                    <div className="font-bold text-[#161B26] tabular-nums">
                      {formatNumber(previewPartition.partition.promptBudget)} tok
                    </div>
                  </div>
                  <div>
                    <div className="text-[#778091]">Output Reserve (max_tokens)</div>
                    <div className="font-bold text-[#161B26] tabular-nums">
                      {formatNumber(previewPartition.partition.outputReserve)} tok
                    </div>
                  </div>
                  <div>
                    <div className="text-[#778091]">Safety Margin</div>
                    <div className="font-bold text-[#161B26] tabular-nums">
                      {formatNumber(previewPartition.partition.safetyMargin)} tok
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* 3. Encrypted Local Storage Vault */}
          <section className="rounded-[8px] border border-[#D3D8DF] bg-white p-5">
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-[#161B26]" />
              <h2 className="text-[15px] font-bold text-[#161B26]">
                Encrypted Local Storage Vault (AES-256-GCM)
              </h2>
            </div>
            <p className="mt-1 text-[12.5px] text-[#778091]">
              Seals your entire local workspace (sessions, memory notes, models, and settings) with
              PBKDF2-SHA256 (150,000 iterations) + AES-256-GCM authenticated encryption, purges
              plaintext storage, and locks the interface until unlocked with your passphrase.
            </p>
            <div className="mt-2 font-mono text-[11.5px] text-[#444D5C]">
              Storage: {settings.storageNamespace}
            </div>

            <form onSubmit={(e) => void handleLockVaultSubmit(e)} className="mt-3.5 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="vault-passphrase-input"
                    className="block text-[12px] font-semibold text-[#444D5C]"
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
                    className="mt-1 w-full rounded-[6px] border border-[#D3D8DF] px-3 py-1.5 text-[13px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="vault-confirm-input"
                    className="block text-[12px] font-semibold text-[#444D5C]"
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
                    className="mt-1 w-full rounded-[6px] border border-[#D3D8DF] px-3 py-1.5 text-[13px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
                  />
                </div>
              </div>

              {vaultError && (
                <div role="alert" className="text-[12.5px] font-medium text-[#D9383A]">
                  {vaultError}
                </div>
              )}

              <button
                type="submit"
                disabled={isSealing}
                className="inline-flex items-center gap-1.5 rounded-[6px] bg-[#161B26] px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-[#2A3FE0] disabled:opacity-50"
              >
                <Lock className="h-3.5 w-3.5" />
                <span>{isSealing ? 'Sealing Vault...' : 'Lock Vault Now'}</span>
              </button>
            </form>
          </section>

          {/* 4. Local Diagnostic Logging Policy */}
          <section className="rounded-[8px] border border-[#D3D8DF] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-[#161B26]" />
                <h2 className="text-[15px] font-bold text-[#161B26]">
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
                  className="rounded-[6px] border border-[#D3D8DF] bg-white px-2.5 py-1 text-[12.5px] text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
                >
                  <option value="disabled">Disabled</option>
                  <option value="minimal_redacted">Minimal Redacted</option>
                  <option value="debug_redacted">Debug Redacted</option>
                </select>
                <button
                  type="button"
                  onClick={onClearDiagnostics}
                  className="inline-flex items-center gap-1 rounded-[6px] border border-[#D3D8DF] bg-white px-2.5 py-1 text-[12px] text-[#444D5C] hover:bg-[#DDE1E7]"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>Clear</span>
                </button>
              </div>
            </div>

            <p className="mt-1 text-[12.5px] text-[#778091]">
              Sensitive prompt content, passphrases, and auth tokens are automatically scrubbed
              before entries enter the in-memory ring buffer.
            </p>

            <div
              data-testid="diagnostic-log-viewer"
              className="mt-3 max-h-48 overflow-y-auto rounded-[6px] border border-[#D3D8DF] bg-[#F7F8F9] p-3 font-mono text-[11.5px] leading-relaxed"
            >
              {diagnosticEntries.length === 0 ? (
                <div className="italic text-[#778091]">
                  {settings.diagnosticLevel === 'disabled'
                    ? 'Diagnostic logging is disabled.'
                    : 'No diagnostic events recorded yet.'}
                </div>
              ) : (
                diagnosticEntries.map((entry) => (
                  <div key={entry.id} className="border-b border-[#E8EBEF] py-1 last:border-b-0">
                    <span className="text-[#778091]">
                      [{new Date(entry.timestamp).toLocaleTimeString()}]
                    </span>{' '}
                    <span
                      className={`font-semibold ${
                        entry.level === 'ERROR'
                          ? 'text-[#D9383A]'
                          : entry.level === 'WARN'
                            ? 'text-[#B45309]'
                            : 'text-[#1D7A4E]'
                      }`}
                    >
                      {entry.level}
                    </span>{' '}
                    <span className="text-[#2A3FE0]">[{entry.module}]</span>{' '}
                    <span className="text-[#161B26]">{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* 5. Privacy & Network Boundary */}
          <section className="rounded-[8px] border border-[#D3D8DF] bg-[#EEF0F3] p-5">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[#1D7A4E]" />
              <h2 className="text-[14.5px] font-bold text-[#161B26]">
                Local Privacy & Loopback Boundary
              </h2>
            </div>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[#444D5C]">
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
