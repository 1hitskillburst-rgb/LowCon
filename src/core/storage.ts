import { DEFAULT_LM_STUDIO_ENDPOINT, type DiagnosticLogger } from './privacy';
import { createDefaultTheme, normalizeHexColor } from './theme';
import type {
  AppSettings,
  MemoryNote,
  ModelProfile,
  PersistedWorkspace,
  PromptEffortPrompts,
  Session,
  ThemePresetId,
  ThemeSettings,
} from './types';
import {
  decryptVaultStringAndKey,
  encryptVaultString,
  encryptVaultStringWithKey,
  type VaultSessionKey,
} from './vault';

export const DEFAULT_PROMPT_EFFORT_PROMPTS: PromptEffortPrompts = {
  low: 'Keep reasoning brief and direct. Prioritize concise, fast answers with minimal step-by-step deliberation.',
  medium:
    'Use balanced reasoning. Think through key constraints and edge cases before answering clearly.',
  high: 'Think thoroughly step by step. Verify assumptions, edge cases, and constraints carefully before giving your final answer.',
  xhigh:
    'Perform exhaustive, deep first-principles reasoning. Carefully analyze all edge cases, alternatives, and invariants before producing a comprehensive answer.',
};

const WORKSPACE_STORAGE_KEY = 'lowcon.workspace.v1';
const VAULT_STORAGE_KEY = 'lowcon.vault.sealed.v1';
const THEME_PREF_STORAGE_KEY = 'lowcon.theme.pref.v1';
const DEFAULT_BUILTIN_MAX_CONTEXT = 131072;

// In-memory AES-256-GCM key while an encrypted vault is unlocked.
// Never persisted to disk/localStorage so reloads or crashes always require re-unlocking.
let activeVaultSessionKey: VaultSessionKey | null = null;
let encryptedSaveQueue: Promise<unknown> = Promise.resolve();

export function isVaultModeActive(): boolean {
  return activeVaultSessionKey !== null;
}

export function clearActiveVaultKey(): void {
  activeVaultSessionKey = null;
}

export function saveThemePreference(theme?: Partial<ThemeSettings>): void {
  try {
    const defaults = createDefaultTheme();
    const presetRaw = theme?.preset;
    const preset: ThemePresetId =
      presetRaw === 'white' || presetRaw === 'gray' || presetRaw === 'black' || presetRaw === 'custom'
        ? presetRaw
        : defaults.preset;
    const sanitized: ThemeSettings = {
      preset,
      bg: normalizeHexColor(theme?.bg ?? '', defaults.bg),
      surface: normalizeHexColor(theme?.surface ?? '', defaults.surface),
      sidebar: normalizeHexColor(theme?.sidebar ?? '', defaults.sidebar),
      accent: normalizeHexColor(theme?.accent ?? '', defaults.accent),
    };
    globalThis.localStorage?.setItem(THEME_PREF_STORAGE_KEY, JSON.stringify(sanitized));
  } catch {
    // Ignore storage quota / private mode failures for non-critical theme hint
  }
}

export function loadSavedThemePreference(): ThemeSettings {
  const defaults = createDefaultTheme();
  try {
    const raw = globalThis.localStorage?.getItem(THEME_PREF_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<ThemeSettings>;
    const presetRaw = parsed?.preset;
    const preset: ThemePresetId =
      presetRaw === 'white' || presetRaw === 'gray' || presetRaw === 'black' || presetRaw === 'custom'
        ? presetRaw
        : defaults.preset;
    return {
      preset,
      bg: normalizeHexColor(parsed?.bg ?? '', defaults.bg),
      surface: normalizeHexColor(parsed?.surface ?? '', defaults.surface),
      sidebar: normalizeHexColor(parsed?.sidebar ?? '', defaults.sidebar),
      accent: normalizeHexColor(parsed?.accent ?? '', defaults.accent),
    };
  } catch {
    return defaults;
  }
}

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
    diagnosticLevel: 'disabled',
    lmStudioEndpoint: DEFAULT_LM_STUDIO_ENDPOINT,
    activeBackendType: 'mock',
    connectedLmModels: [],
    selectedLmModel: '',
    modelDisplayAliases: {},
    modelIconOverrides: {},
    allowAiFileEdits: true,
    connectionStatus: 'Not tested yet',
    storageNamespace: 'localStorage://lowcon.workspace.v1 (Unsealed — enable Vault for AES-256-GCM at rest)',
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
    workspaceFiles: [],
    settings: {
      ...createDefaultSettings(),
      theme: loadSavedThemePreference(),
    },
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

    const mergedTheme: ThemeSettings = {
      ...createDefaultTheme(),
      ...(parsed.settings?.theme ?? {}),
    };
    saveThemePreference(mergedTheme);

    return {
      workspace: {
        version: 1,
        sessions: parsed.sessions,
        activeSessionId,
        models,
        activeModelId,
        memoryNotes: Array.isArray(parsed.memoryNotes) ? parsed.memoryNotes : defaults.memoryNotes,
        workspaceFiles: Array.isArray(parsed.workspaceFiles) ? parsed.workspaceFiles : [],
        settings: {
          ...defaults.settings,
          ...(parsed.settings ?? {}),
          modelDisplayAliases: {
            ...(parsed.settings?.modelDisplayAliases ?? {}),
          },
          modelIconOverrides: {
            ...(parsed.settings?.modelIconOverrides ?? {}),
          },
          theme: mergedTheme,
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
    saveThemePreference(workspace.settings.theme);
    globalThis.localStorage?.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('storage', `Failed to persist workspace: ${msg}`);
    return { ok: false, error: `Failed to save workspace locally: ${msg}` };
  }
}

/**
 * Persists the active workspace cleanly:
 * - When an encrypted vault session is unlocked, re-encrypts with the in-memory
 *   AES-256-GCM key and writes ONLY to `lowcon.vault.sealed.v1` (never plaintext).
 * - Otherwise writes to `lowcon.workspace.v1`.
 */
export function persistActiveWorkspace(
  workspace: PersistedWorkspace,
  logger: DiagnosticLogger,
): Promise<{ ok: true } | { ok: false; error: string }> {
  saveThemePreference(workspace.settings.theme);
  const sessionKey = activeVaultSessionKey;
  if (!sessionKey) {
    return Promise.resolve(saveUnsealedWorkspace(workspace, logger));
  }

  const run = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const plaintext = JSON.stringify(workspace);
      const sealed = await encryptVaultStringWithKey(sessionKey, plaintext);
      globalThis.localStorage?.setItem(VAULT_STORAGE_KEY, sealed);
      globalThis.localStorage?.removeItem(WORKSPACE_STORAGE_KEY);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('vault', `Encrypted workspace persistence failed: ${msg}`);
      return { ok: false, error: `Failed to save encrypted vault locally: ${msg}` };
    }
  };

  const next = encryptedSaveQueue.then(run, run);
  encryptedSaveQueue = next;
  return next;
}

/**
 * Seals the entire persisted workspace with AES-256-GCM + PBKDF2-SHA256,
 * wipes the plaintext localStorage copy, and clears the in-memory session key.
 */
export async function sealWorkspaceVault(
  workspace: PersistedWorkspace,
  passphrase: string,
  logger: DiagnosticLogger,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    saveThemePreference(workspace.settings.theme);
    const updatedWorkspace: PersistedWorkspace = {
      ...workspace,
      settings: {
        ...workspace.settings,
        storageNamespace: 'localStorage://lowcon.vault.sealed.v1 (AES-256-GCM encrypted at rest)',
      },
    };
    const plaintext = JSON.stringify(updatedWorkspace);
    const sealed = await encryptVaultString(passphrase, plaintext);
    globalThis.localStorage?.setItem(VAULT_STORAGE_KEY, sealed);
    globalThis.localStorage?.removeItem(WORKSPACE_STORAGE_KEY);
    activeVaultSessionKey = null;
    logger.info('vault', 'Workspace sealed with AES-256-GCM and plaintext storage purged.');
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('vault', `Vault seal failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Immediately re-locks an already-active vault session by flushing the latest
 * encrypted snapshot and clearing the in-memory key (no passphrase re-entry required).
 */
export async function lockActiveVaultNow(
  workspace: PersistedWorkspace,
  logger: DiagnosticLogger,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!activeVaultSessionKey) {
    return { ok: false, error: 'Vault encryption is not currently active.' };
  }
  const saved = await persistActiveWorkspace(workspace, logger);
  if (!saved.ok) {
    return saved;
  }
  activeVaultSessionKey = null;
  logger.info('vault', 'Active vault locked and in-memory key cleared.');
  return { ok: true };
}

/**
 * Decrypts and restores the sealed workspace after verifying passphrase integrity.
 * Keeps the derived AES-256-GCM key in memory and NEVER writes plaintext back to localStorage.
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
    const { plaintext, sessionKey } = await decryptVaultStringAndKey(passphrase, sealed);
    const rawWorkspace = JSON.parse(plaintext) as PersistedWorkspace;
    const defaults = createDefaultSettings();
    const mergedTheme: ThemeSettings = {
      ...createDefaultTheme(),
      ...(rawWorkspace.settings?.theme ?? {}),
    };
    saveThemePreference(mergedTheme);

    const workspace: PersistedWorkspace = {
      ...rawWorkspace,
      models: Array.isArray(rawWorkspace.models)
        ? upgradeBuiltinModelLimits(rawWorkspace.models)
        : createDefaultModels(),
      workspaceFiles: Array.isArray(rawWorkspace.workspaceFiles)
        ? rawWorkspace.workspaceFiles
        : [],
      settings: {
        ...defaults,
        ...(rawWorkspace.settings ?? {}),
        storageNamespace: 'localStorage://lowcon.vault.sealed.v1 (AES-256-GCM encrypted at rest)',
        modelDisplayAliases: {
          ...(rawWorkspace.settings?.modelDisplayAliases ?? {}),
        },
        modelIconOverrides: {
          ...(rawWorkspace.settings?.modelIconOverrides ?? {}),
        },
        theme: mergedTheme,
        promptEffortPrompts: {
          ...DEFAULT_PROMPT_EFFORT_PROMPTS,
          ...(rawWorkspace.settings?.promptEffortPrompts ?? {}),
        },
      },
    };

    activeVaultSessionKey = sessionKey;
    // Ensure no legacy plaintext copy lingers on disk
    globalThis.localStorage?.removeItem(WORKSPACE_STORAGE_KEY);
    logger.info('vault', 'Vault unlocked (data remains AES-256-GCM encrypted at rest).');
    return { ok: true, workspace };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('vault', `Vault unlock rejected: ${msg}`);
    return { ok: false, error: msg };
  }
}

/**
 * Explicitly disables vault encryption at rest (user opt-out from Settings),
 * moving storage back to standard unsealed localStorage and clearing the vault key.
 */
export function disableVaultEncryption(
  workspace: PersistedWorkspace,
  logger: DiagnosticLogger,
): { ok: true; workspace: PersistedWorkspace } | { ok: false; error: string } {
  const updatedWorkspace: PersistedWorkspace = {
    ...workspace,
    settings: {
      ...workspace.settings,
      storageNamespace:
        'localStorage://lowcon.workspace.v1 (Unsealed — enable Vault for AES-256-GCM at rest)',
    },
  };
  const saveRes = saveUnsealedWorkspace(updatedWorkspace, logger);
  if (!saveRes.ok) {
    return saveRes;
  }
  activeVaultSessionKey = null;
  try {
    globalThis.localStorage?.removeItem(VAULT_STORAGE_KEY);
  } catch {
    // Ignore
  }
  logger.info('vault', 'Vault encryption disabled by user; switched to unsealed local storage.');
  return { ok: true, workspace: updatedWorkspace };
}

/**
 * Permanently erases any sealed vault and local workspace data (recovery path for forgotten passphrase)
 * and returns a fresh default workspace while preserving the user's non-sensitive UI theme preference.
 */
export function resetAndWipeVault(logger?: DiagnosticLogger): PersistedWorkspace {
  activeVaultSessionKey = null;
  try {
    globalThis.localStorage?.removeItem(VAULT_STORAGE_KEY);
    globalThis.localStorage?.removeItem(WORKSPACE_STORAGE_KEY);
  } catch {
    // Ignore
  }
  const fresh = createDefaultWorkspace();
  if (logger) {
    saveUnsealedWorkspace(fresh, logger);
    logger.warn('vault', 'Local vault and workspace erased; initialized a fresh workspace.');
  } else {
    try {
      saveThemePreference(fresh.settings.theme);
      globalThis.localStorage?.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(fresh));
    } catch {
      // Ignore storage quota failures during emergency reset
    }
  }
  return fresh;
}
