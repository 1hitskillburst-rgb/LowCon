import { DEFAULT_LM_STUDIO_ENDPOINT, type DiagnosticLogger } from './privacy';
import { createDefaultTheme } from './theme';
import type {
  AppSettings,
  MemoryNote,
  ModelProfile,
  PersistedWorkspace,
  PromptEffortPrompts,
  Session,
} from './types';

export const DEFAULT_PROMPT_EFFORT_PROMPTS: PromptEffortPrompts = {
  low: 'Keep reasoning brief and direct. Prioritize concise, fast answers with minimal step-by-step deliberation.',
  medium:
    'Use balanced reasoning. Think through key constraints and edge cases before answering clearly.',
  high: 'Think thoroughly step by step. Verify assumptions, edge cases, and constraints carefully before giving your final answer.',
  xhigh:
    'Perform exhaustive, deep first-principles reasoning. Carefully analyze all edge cases, alternatives, and invariants before producing a comprehensive answer.',
};
import { decryptVaultString, encryptVaultString } from './vault';

const WORKSPACE_STORAGE_KEY = 'lowcon.workspace.v1';
const VAULT_STORAGE_KEY = 'lowcon.vault.sealed.v1';
const DEFAULT_BUILTIN_MAX_CONTEXT = 131072;

export function createUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDefaultSettings(): AppSettings {
  return {
    outputReservePct: 20,
    safetyMarginPct: 5,
    contextLimitOverride: 8192,
    memoryRetrievalEnabled: true,
    diagnosticLevel: 'minimal_redacted',
    lmStudioEndpoint: DEFAULT_LM_STUDIO_ENDPOINT,
    activeBackendType: 'mock',
    connectedLmModels: [],
    selectedLmModel: '',
    modelDisplayAliases: {},
    connectionStatus: 'Not tested yet',
    storageNamespace: 'localStorage://lowcon.workspace.v1 (Encrypted on Vault Lock)',
    theme: createDefaultTheme(),
    chatWidth: 'default',
    effortLevel: 'medium',
    promptEffortEnabled: false,
    promptEffortPrompts: { ...DEFAULT_PROMPT_EFFORT_PROMPTS },
  };
}

export function createDefaultModels(): ModelProfile[] {
  return [
    {
      id: 'model_offline_mock',
      name: 'Offline Mock · Deterministic Local Harness',
      filePath: 'in-process://deterministic-mock',
      backendType: 'mock',
      architecture: 'qwen2',
      quantization: 'Deterministic',
      contextLimit: DEFAULT_BUILTIN_MAX_CONTEXT,
      chatTemplate: 'ChatML',
      fileSizeBytes: 0,
      ramFootprintMb: 12,
    },
    {
      id: 'model_lmstudio',
      name: 'LM Studio · Local Server (127.0.0.1:1234)',
      filePath: DEFAULT_LM_STUDIO_ENDPOINT,
      backendType: 'lm_studio',
      architecture: 'openai-compatible',
      quantization: 'Server-managed',
      contextLimit: DEFAULT_BUILTIN_MAX_CONTEXT,
      chatTemplate: 'ChatML',
      fileSizeBytes: 0,
    },
  ];
}

function upgradeBuiltinModelLimits(models: ModelProfile[]): ModelProfile[] {
  return models.map((m) => {
    if (
      (m.id === 'model_offline_mock' || m.id === 'model_lmstudio') &&
      m.contextLimit < DEFAULT_BUILTIN_MAX_CONTEXT
    ) {
      return { ...m, contextLimit: DEFAULT_BUILTIN_MAX_CONTEXT };
    }
    return m;
  });
}

export function createDefaultMemoryNotes(sessionId: string): MemoryNote[] {
  const now = Date.now();
  return [
    {
      id: 'note_rule_history',
      sessionId: undefined,
      title: 'Keep original conversation history intact',
      content:
        'Never mutate or truncate stored transcript records when trimming prompts for low-context windows.',
      sourceReference: 'Pinned project invariant',
      sourceMessageIds: [],
      isPinned: true,
      isSummary: false,
      isDisabled: false,
      userApproved: true,
      createdAt: now - 3600_000,
      updatedAt: now - 3600_000,
    },
    {
      id: 'note_deterministic_packing',
      sessionId,
      title: 'Prefer deterministic prompt packing over implicit recall',
      content:
        'Pack core instructions, pinned rules, active task state, scored memory notes, and newest turns strictly within prompt_budget.',
      sourceReference: 'Local architecture memory',
      sourceMessageIds: [],
      isPinned: false,
      isSummary: false,
      isDisabled: false,
      userApproved: true,
      createdAt: now - 1800_000,
      updatedAt: now - 1800_000,
    },
  ];
}

export function createDefaultWorkspace(): PersistedWorkspace {
  const now = Date.now();
  const initialSessionId = createUuid();
  const initialSession: Session = {
    id: initialSessionId,
    title: 'Context strategy / 8K model',
    subtitle: 'Focused local session. History and settings persist locally on this device.',
    createdAt: now,
    updatedAt: now,
    messages: [],
  };

  const models = createDefaultModels();
  return {
    version: 1,
    sessions: [initialSession],
    activeSessionId: initialSessionId,
    models,
    activeModelId: models[0].id,
    memoryNotes: createDefaultMemoryNotes(initialSessionId),
    settings: createDefaultSettings(),
  };
}

export function isVaultSealed(): boolean {
  try {
    return Boolean(globalThis.localStorage?.getItem(VAULT_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function loadUnsealedWorkspace(logger: DiagnosticLogger): {
  workspace: PersistedWorkspace;
  storageWarning?: string;
} {
  try {
    const raw = globalThis.localStorage?.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) {
      const fresh = createDefaultWorkspace();
      saveUnsealedWorkspace(fresh, logger);
      return { workspace: fresh };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspace>;
    if (!parsed || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
      throw new Error('Stored workspace is missing sessions array.');
    }

    const defaults = createDefaultWorkspace();
    const rawModels =
      Array.isArray(parsed.models) && parsed.models.length > 0 ? parsed.models : defaults.models;
    const models = upgradeBuiltinModelLimits(rawModels);
    const activeModelId =
      typeof parsed.activeModelId === 'string' && models.some((m) => m.id === parsed.activeModelId)
        ? parsed.activeModelId
        : models[0].id;
    const activeSessionId =
      typeof parsed.activeSessionId === 'string' &&
      parsed.sessions.some((s) => s.id === parsed.activeSessionId)
        ? parsed.activeSessionId
        : parsed.sessions[0].id;

    return {
      workspace: {
        version: 1,
        sessions: parsed.sessions,
        activeSessionId,
        models,
        activeModelId,
        memoryNotes: Array.isArray(parsed.memoryNotes) ? parsed.memoryNotes : defaults.memoryNotes,
        settings: {
          ...defaults.settings,
          ...(parsed.settings ?? {}),
          modelDisplayAliases: {
            ...(parsed.settings?.modelDisplayAliases ?? {}),
          },
          theme: {
            ...createDefaultTheme(),
            ...(parsed.settings?.theme ?? {}),
          },
          promptEffortPrompts: {
            ...DEFAULT_PROMPT_EFFORT_PROMPTS,
            ...(parsed.settings?.promptEffortPrompts ?? {}),
          },
        },
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('storage', `Failed to load persisted workspace: ${msg}`);
    return {
      workspace: createDefaultWorkspace(),
      storageWarning: `Local storage could not be read (${msg}). Initialized a fresh local workspace.`,
    };
  }
}

export function saveUnsealedWorkspace(
  workspace: PersistedWorkspace,
  logger: DiagnosticLogger,
): { ok: true } | { ok: false; error: string } {
  try {
    globalThis.localStorage?.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('storage', `Failed to persist workspace: ${msg}`);
    return { ok: false, error: `Failed to save workspace locally: ${msg}` };
  }
}

/**
 * Seals the entire persisted workspace with AES-256-GCM + PBKDF2-SHA256
 * and wipes the plaintext localStorage copy.
 */
export async function sealWorkspaceVault(
  workspace: PersistedWorkspace,
  passphrase: string,
  logger: DiagnosticLogger,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const plaintext = JSON.stringify(workspace);
    const sealed = await encryptVaultString(passphrase, plaintext);
    globalThis.localStorage?.setItem(VAULT_STORAGE_KEY, sealed);
    globalThis.localStorage?.removeItem(WORKSPACE_STORAGE_KEY);
    logger.info('vault', 'Workspace sealed with AES-256-GCM and plaintext storage purged.');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('vault', `Vault seal failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Decrypts and restores the sealed workspace after verifying passphrase integrity.
 */
export async function unsealWorkspaceVault(
  passphrase: string,
  logger: DiagnosticLogger,
): Promise<{ ok: true; workspace: PersistedWorkspace } | { ok: false; error: string }> {
  try {
    const sealed = globalThis.localStorage?.getItem(VAULT_STORAGE_KEY);
    if (!sealed) {
      return { ok: false, error: 'No sealed vault payload found in local storage.' };
    }
    const plaintext = await decryptVaultString(passphrase, sealed);
    const rawWorkspace = JSON.parse(plaintext) as PersistedWorkspace;
    const defaults = createDefaultSettings();
    const workspace: PersistedWorkspace = {
      ...rawWorkspace,
      models: Array.isArray(rawWorkspace.models)
        ? upgradeBuiltinModelLimits(rawWorkspace.models)
        : createDefaultModels(),
      settings: {
        ...defaults,
        ...(rawWorkspace.settings ?? {}),
        modelDisplayAliases: {
          ...(rawWorkspace.settings?.modelDisplayAliases ?? {}),
        },
        theme: {
          ...createDefaultTheme(),
          ...(rawWorkspace.settings?.theme ?? {}),
        },
        promptEffortPrompts: {
          ...DEFAULT_PROMPT_EFFORT_PROMPTS,
          ...(rawWorkspace.settings?.promptEffortPrompts ?? {}),
        },
      },
    };
    globalThis.localStorage?.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    globalThis.localStorage?.removeItem(VAULT_STORAGE_KEY);
    logger.info('vault', 'Vault unlocked and workspace restored cleanly.');
    return { ok: true, workspace };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('vault', `Vault unlock rejected: ${msg}`);
    return { ok: false, error: msg };
  }
}
