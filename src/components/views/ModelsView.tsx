import React, { useRef, useState } from 'react';
import { CheckCircle2, Cpu, FileUp, Plus, Power, Trash2, X } from 'lucide-react';
import { parseGgufHeader } from '../../core/gguf';
import { formatNumber } from '../../core/privacy';
import { createUuid } from '../../core/storage';
import type { ChatTemplateType, ModelProfile, WorkerStatus } from '../../core/types';

interface ModelsViewProps {
  models: ModelProfile[];
  activeModelId: string;
  workerStatus: WorkerStatus;
  globalContextOverride: number;
  lmStudioEndpoint: string;
  onSelectActiveModel: (modelId: string) => void;
  onLoadModel: (modelId: string) => void;
  onUnloadModel: () => void;
  onAddModel: (profile: ModelProfile) => void;
  onUpdateModel: (modelId: string, patch: Partial<ModelProfile>) => void;
  onRemoveModel: (modelId: string) => void;
}

const CHAT_TEMPLATES: ChatTemplateType[] = ['ChatML', 'Llama3', 'Llama2', 'Mistral', 'Gemma', 'Raw'];

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return 'In-process / server';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export const ModelsView: React.FC<ModelsViewProps> = ({
  models,
  activeModelId,
  workerStatus,
  globalContextOverride,
  lmStudioEndpoint,
  onSelectActiveModel,
  onLoadModel,
  onUnloadModel,
  onAddModel,
  onUpdateModel,
  onRemoveModel,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const resolvedDefaultEndpoint = lmStudioEndpoint.trim() || 'http://127.0.0.1:1234/v1';
  const [parseMessage, setParseMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
    null,
  );
  const [isDraggingGguf, setIsDraggingGguf] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEndpoint, setNewEndpoint] = useState(resolvedDefaultEndpoint);
  const [newBackend, setNewBackend] = useState<'mock' | 'lm_studio'>('lm_studio');
  const [newContextLimit, setNewContextLimit] = useState(8192);
  const [newTemplate, setNewTemplate] = useState<ChatTemplateType>('ChatML');

  const loadedModelId =
    workerStatus.state === 'loaded' || workerStatus.state === 'generating'
      ? workerStatus.modelId
      : null;

  const inspectGgufFile = async (file: File) => {
    setParseMessage(null);
    if (!file.name.toLowerCase().endsWith('.gguf')) {
      setParseMessage({
        kind: 'err',
        text: `Unsupported file '${file.name}'. Please select or drop a .gguf model file.`,
      });
      return;
    }

    try {
      // Read up to 4 MB of the binary header (enough for GGUF v1/v2/v3 metadata without loading GB weights)
      const headerSlice = file.slice(0, Math.min(file.size, 4 * 1024 * 1024));
      const buffer = await headerSlice.arrayBuffer();
      const parsed = parseGgufHeader(buffer, file.size, file.name);

      const profile: ModelProfile = {
        id: `gguf_${createUuid().slice(0, 8)}`,
        name: `${parsed.name} (${parsed.quantization})`,
        filePath: resolvedDefaultEndpoint,
        backendType: 'lm_studio',
        architecture: parsed.architecture,
        quantization: parsed.quantization,
        contextLimit: parsed.contextLength,
        chatTemplate: parsed.inferredTemplateType,
        fileSizeBytes: parsed.fileSizeBytes,
        tensorCount: parsed.tensorCount,
      };
      onAddModel(profile);
      setParseMessage({
        kind: 'ok',
        text: `Parsed GGUF v${parsed.version} header: ${parsed.name} · arch=${parsed.architecture} · quant=${parsed.quantization} · ctx=${formatNumber(parsed.contextLength)} · template=${parsed.inferredTemplateType}. Profile added (routes through ${resolvedDefaultEndpoint}).`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setParseMessage({ kind: 'err', text: `GGUF inspection failed: ${msg}` });
    }
  };

  const handleGgufInspect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await inspectGgufFile(file);
  };

  const handleGgufDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDraggingGguf) {
      setIsDraggingGguf(true);
    }
  };

  const handleGgufDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingGguf(false);
  };

  const handleGgufDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingGguf(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      void inspectGgufFile(file);
    }
  };

  const handleCreateCustomProfile = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    const profile: ModelProfile = {
      id: `model_${createUuid().slice(0, 8)}`,
      name: newName.trim(),
      filePath:
        newBackend === 'lm_studio'
          ? newEndpoint.trim() || resolvedDefaultEndpoint
          : 'in-process://deterministic-mock',
      backendType: newBackend,
      architecture: newBackend === 'lm_studio' ? 'openai-compatible' : 'qwen2',
      quantization: newBackend === 'lm_studio' ? 'Server-managed' : 'Deterministic',
      contextLimit: Math.max(256, Number(newContextLimit) || 8192),
      chatTemplate: newTemplate,
      fileSizeBytes: 0,
    };
    onAddModel(profile);
    setNewName('');
    setShowAddForm(false);
    setParseMessage({ kind: 'ok', text: `Added local model profile "${profile.name}".` });
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--lc-bg)] text-[var(--lc-ink)]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-[var(--lc-line)] px-7 py-3">
        <div className="flex items-center text-[13px]">
          <span className="text-[var(--lc-mute)]">Workspace /</span>
          <span className="ml-1 font-semibold text-[var(--lc-ink)]">Models</span>
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".gguf"
            onChange={(e) => void handleGgufInspect(e)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--lc-surf-ink)] hover:bg-[var(--lc-surf-hover)]"
          >
            <FileUp className="h-3.5 w-3.5" />
            <span>Inspect .gguf Header</span>
          </button>
          <button
            type="button"
            onClick={() => setShowAddForm((prev) => !prev)}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-[var(--lc-accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)]"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Profile</span>
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto max-w-[820px] space-y-5">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight text-[var(--lc-ink)]">
              Local Model Profiles
            </h1>
            <p className="mt-1 text-[13.5px] text-[var(--lc-ink2)]">
              Inspect GGUF v1/v2/v3 headers directly in-browser, configure per-model context limits
              and chat templates, and manage the live inference worker state.
            </p>
          </div>

          {/* Real Worker Status Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[var(--lc-line)] bg-[var(--lc-panel)] px-4 py-3 text-[var(--lc-side-ink)]">
            <div className="flex items-center gap-2.5 text-[13px]">
              <Cpu className="h-4 w-4 text-[var(--lc-side-ink)]" />
              <span className="font-semibold text-[var(--lc-side-ink)]">Inference Worker:</span>
              {workerStatus.state === 'loaded' && (
                <span className="font-medium text-[var(--lc-success)]">
                  Loaded — {workerStatus.modelName} ({formatNumber(workerStatus.contextLimit)} ctx)
                </span>
              )}
              {workerStatus.state === 'generating' && (
                <span className="font-medium text-[var(--lc-accent)]">
                  Generating — {workerStatus.modelName}
                </span>
              )}
              {workerStatus.state === 'loading' && (
                <span className="text-[var(--lc-side-ink2)]">Loading {workerStatus.modelName}...</span>
              )}
              {workerStatus.state === 'unloaded' && (
                <span className="text-[var(--lc-side-mute)]">Unloaded (no model active in worker)</span>
              )}
              {workerStatus.state === 'error' && (
                <span className="font-medium text-[var(--lc-danger)]">Error — {workerStatus.message}</span>
              )}
            </div>

            {loadedModelId && (
              <button
                type="button"
                onClick={onUnloadModel}
                className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1 text-[12px] font-medium text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-danger)]"
              >
                <Power className="h-3.5 w-3.5" />
                <span>Unload Worker</span>
              </button>
            )}
          </div>

          {/* GGUF Drag-and-Drop Inspector Card */}
          <div
            data-testid="gguf-dropzone"
            onDragEnter={handleGgufDragOver}
            onDragOver={handleGgufDragOver}
            onDragLeave={handleGgufDragLeave}
            onDrop={handleGgufDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            aria-label="Drop a .gguf file here or click to inspect its header"
            className={`flex cursor-pointer items-center justify-between gap-3 rounded-[8px] border border-dashed px-4 py-3 text-[13px] transition-colors ${
              isDraggingGguf
                ? 'border-[var(--lc-accent)] bg-[var(--lc-accent)]/10 text-[var(--lc-accent)]'
                : 'border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink2)] hover:border-[var(--lc-accent)]'
            }`}
          >
            <div className="flex items-center gap-2.5">
              <FileUp className="h-4 w-4 shrink-0" />
              <span>
                Drop a local <code className="font-mono text-[12px]">.gguf</code> file here (or click)
                to inspect its binary header and create a profile targeting{' '}
                <code className="font-mono text-[12px]">{resolvedDefaultEndpoint}</code>.
              </span>
            </div>
          </div>

          {parseMessage && (
            <div
              role={parseMessage.kind === 'err' ? 'alert' : 'status'}
              className={`flex items-start justify-between gap-3 rounded-[8px] border px-4 py-2.5 text-[13px] ${
                parseMessage.kind === 'ok'
                  ? 'border-[var(--lc-success)]/30 bg-[var(--lc-success)]/8 text-[var(--lc-success)]'
                  : 'border-[var(--lc-danger)]/30 bg-[var(--lc-danger)]/8 text-[var(--lc-danger)]'
              }`}
            >
              <span>{parseMessage.text}</span>
              <button
                type="button"
                onClick={() => setParseMessage(null)}
                aria-label="Dismiss notification"
                className="shrink-0 opacity-70 hover:opacity-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* Add Custom Profile Form */}
          {showAddForm && (
            <form
              onSubmit={handleCreateCustomProfile}
              className="space-y-3 rounded-[8px] border border-[var(--lc-accent)] bg-[var(--lc-surface)] p-4 text-[var(--lc-surf-ink)]"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-[14px] font-bold text-[var(--lc-surf-ink)]">Add Local Model Profile</h2>
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  aria-label="Close add profile form"
                  className="text-[var(--lc-surf-mute)] hover:text-[var(--lc-surf-ink)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="new-model-name" className="block text-[12px] font-medium text-[var(--lc-surf-ink2)]">
                    Profile Name
                  </label>
                  <input
                    id="new-model-name"
                    type="text"
                    required
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. Qwen2.5-7B-Instruct Q4_K_M"
                    className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1.5 text-[13px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="new-model-backend" className="block text-[12px] font-medium text-[var(--lc-surf-ink2)]">
                    Inference Backend
                  </label>
                  <select
                    id="new-model-backend"
                    value={newBackend}
                    onChange={(e) => setNewBackend(e.target.value as 'mock' | 'lm_studio')}
                    className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1.5 text-[13px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                  >
                    <option value="lm_studio">LM Studio / Local OpenAI Server</option>
                    <option value="mock">Offline Mock Harness</option>
                  </select>
                </div>
                {newBackend === 'lm_studio' && (
                  <div>
                    <label htmlFor="new-model-endpoint" className="block text-[12px] font-medium text-[var(--lc-surf-ink2)]">
                      Local Loopback Endpoint
                    </label>
                    <input
                      id="new-model-endpoint"
                      type="text"
                      value={newEndpoint}
                      onChange={(e) => setNewEndpoint(e.target.value)}
                      className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1.5 font-mono text-[12.5px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                    />
                  </div>
                )}
                <div>
                  <label htmlFor="new-model-ctx" className="block text-[12px] font-medium text-[var(--lc-surf-ink2)]">
                    Native Context Limit (tokens)
                  </label>
                  <input
                    id="new-model-ctx"
                    type="number"
                    min={256}
                    max={131072}
                    step={256}
                    value={newContextLimit}
                    onChange={(e) => setNewContextLimit(Number(e.target.value))}
                    className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1.5 text-[13px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                  />
                </div>
                <div>
                  <label htmlFor="new-model-template" className="block text-[12px] font-medium text-[var(--lc-surf-ink2)]">
                    Chat Template
                  </label>
                  <select
                    id="new-model-template"
                    value={newTemplate}
                    onChange={(e) => setNewTemplate(e.target.value as ChatTemplateType)}
                    className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1.5 text-[13px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                  >
                    {CHAT_TEMPLATES.map((tpl) => (
                      <option key={tpl} value={tpl}>
                        {tpl}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAddForm(false)}
                  className="rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[12.5px] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-[6px] bg-[var(--lc-accent)] px-3.5 py-1.5 text-[12.5px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)]"
                >
                  Save Profile
                </button>
              </div>
            </form>
          )}

          {/* Model Cards */}
          <div className="space-y-3">
            {models.map((model) => {
              const isLoadedInWorker = loadedModelId === model.id;
              const isSelectedActive = activeModelId === model.id;
              const effectiveLimit = Math.min(
                model.contextOverride ?? model.contextLimit,
                globalContextOverride,
              );

              return (
                <section
                  key={model.id}
                  data-testid={`model-card-${model.id}`}
                  className={`rounded-[8px] border bg-[var(--lc-surface)] p-4 text-[var(--lc-surf-ink)] transition-colors ${
                    isLoadedInWorker ? 'border-[var(--lc-accent)]' : 'border-[var(--lc-surf-line)]'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-[15px] font-bold text-[var(--lc-surf-ink)]">{model.name}</h2>
                        {isLoadedInWorker && (
                          <span
                            data-testid="worker-loaded-badge"
                            className="inline-flex items-center gap-1 rounded-[4px] bg-[var(--lc-success)]/15 px-2 py-0.5 text-[11px] font-bold tracking-wide text-[var(--lc-success)]"
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            LOADED
                          </span>
                        )}
                        {isSelectedActive && !isLoadedInWorker && (
                          <span className="rounded-[4px] bg-[var(--lc-panel)] px-2 py-0.5 text-[11px] font-semibold text-[var(--lc-side-ink2)]">
                            ACTIVE PROFILE (UNLOADED)
                          </span>
                        )}
                      </div>

                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--lc-surf-mute)]">
                        <span>Backend: {model.backendType === 'mock' ? 'Offline Mock' : 'LM Studio'}</span>
                        <span>Arch: {model.architecture}</span>
                        <span>Quant: {model.quantization}</span>
                        <span>Size: {formatBytes(model.fileSizeBytes)}</span>
                        <span>Effective ctx: {formatNumber(effectiveLimit)} tok</span>
                      </div>
                      <div className="mt-1 truncate font-mono text-[11.5px] text-[var(--lc-surf-mute)]">
                        {model.filePath}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {isLoadedInWorker ? (
                        <button
                          type="button"
                          onClick={onUnloadModel}
                          aria-label={`Unload ${model.name}`}
                          className="rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]"
                        >
                          Unload
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            onSelectActiveModel(model.id);
                            onLoadModel(model.id);
                          }}
                          aria-label={`Load ${model.name}`}
                          className="rounded-[6px] bg-[var(--lc-accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--lc-accent-contrast)] hover:bg-[var(--lc-accent-hover)]"
                        >
                          Load Model
                        </button>
                      )}

                      {models.length > 1 && (
                        <button
                          type="button"
                          onClick={() => onRemoveModel(model.id)}
                          aria-label={`Remove ${model.name}`}
                          title="Remove model profile"
                          className="rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-1.5 text-[var(--lc-surf-mute)] hover:border-[var(--lc-danger)] hover:text-[var(--lc-danger)]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Per-Model Configuration Controls */}
                  <div className="mt-3.5 grid grid-cols-1 gap-4 border-t border-[var(--lc-line-soft)] pt-3 sm:grid-cols-2">
                    <div>
                      <div className="flex items-center justify-between text-[12px]">
                        <label
                          htmlFor={`ctx-override-${model.id}`}
                          className="font-medium text-[var(--lc-surf-ink2)]"
                        >
                          Model Context Cap
                        </label>
                        <span className="font-semibold text-[var(--lc-surf-ink)] tabular-nums">
                          {formatNumber(model.contextOverride ?? model.contextLimit)} /{' '}
                          {formatNumber(model.contextLimit)} tok
                        </span>
                      </div>
                      <input
                        id={`ctx-override-${model.id}`}
                        type="range"
                        min={512}
                        max={Math.max(512, model.contextLimit)}
                        step={512}
                        value={model.contextOverride ?? model.contextLimit}
                        onChange={(e) =>
                          onUpdateModel(model.id, { contextOverride: Number(e.target.value) })
                        }
                        className="mt-1.5 w-full accent-[var(--lc-accent)]"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor={`tpl-select-${model.id}`}
                        className="block text-[12px] font-medium text-[var(--lc-surf-ink2)]"
                      >
                        Chat Template Framing
                      </label>
                      <select
                        id={`tpl-select-${model.id}`}
                        value={model.chatTemplate}
                        onChange={(e) =>
                          onUpdateModel(model.id, {
                            chatTemplate: e.target.value as ChatTemplateType,
                          })
                        }
                        className="mt-1 w-full rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1 text-[12.5px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
                      >
                        {CHAT_TEMPLATES.map((tpl) => (
                          <option key={tpl} value={tpl}>
                            {tpl}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
