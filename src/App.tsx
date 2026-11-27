import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { ChatView } from './components/chat/ChatView';
import { FilePreviewPanel } from './components/chat/FilePreviewPanel';
import { RightSidebarPanel, type RightSidebarTab } from './components/chat/RightSidebarPanel';
import { SidebarNav } from './components/layout/SidebarNav';
import { PromptInspectorModal } from './components/modals/PromptInspectorModal';
import { SourcesModal } from './components/modals/SourcesModal';
import { VaultLockOverlay } from './components/modals/VaultLockOverlay';
import { MemoryView, type MemoryFilter } from './components/views/MemoryView';
import { ModelsView } from './components/views/ModelsView';
import { ProfileView } from './components/views/ProfileView';
import { SettingsView } from './components/views/SettingsView';
import {
  assembleContext,
  buildTurnContextBudget,
  stopSequencesForTemplate,
  type AssemblyCandidates,
  type ConversationTurnCandidate,
} from './core/context';
import {
  buildContinuationInstruction,
  buildThinkingHandoffInstruction,
  computeTurnMaxTokens,
  dedupeContinuationOverlap,
  distillOlderToolTurns,
  MAX_AUTO_CONTINUATION_HOPS,
  THINKING_GUARD_RATIO,
} from './core/continuation';
import {
  fetchLocalLmStudioModels,
  InferenceController,
  unloadLocalLmModels,
  type StreamStopReason,
} from './core/inference';
import {
  buildDraftSessionSummary,
  buildSummaryCandidates,
  getPinnedNotesForPrompt,
  retrieveMemoryNotes,
} from './core/memory';
import { DiagnosticLogger, safeTruncateChars } from './core/privacy';
import { resolveModelDisplayName } from './core/modelNames';
import {
  clampLeftSidebarWidth,
  clampRightSidebarWidth,
  loadSidebarLayoutState,
  saveSidebarLayoutState,
  type SidebarLayoutState,
} from './core/sidebarLayout';
import {
  createDefaultWorkspace,
  createUuid,
  disableVaultEncryption,
  isVaultModeActive,
  isVaultSealed,
  loadUnsealedWorkspace,
  lockActiveVaultNow,
  persistActiveWorkspace,
  resetAndWipeVault,
  saveThemePreference,
  sealWorkspaceVault,
  unsealWorkspaceVault,
} from './core/storage';
import { applyThemeToDocument } from './core/theme';
import { addTokenUsage, createEmptyTokenUsage } from './core/tokenUsage';
import {
  ALL_WORKSPACE_TOOLS,
  buildToolPolicyForTools,
  CALCULATE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  executeCalculateTool,
  executeEditFileTool,
  executeReadAttachedChunkTool,
  executeSaveMemoryNoteTool,
  executeSaveWorkspaceFileTool,
  executeSearchMemoryTool,
  extractEditTargetFilename,
  formatAttachedFileForPrompt,
  getToolPendingActivityLabel,
  hasExplicitWorkspaceFileSaveIntent,
  READ_ATTACHED_CHUNK_TOOL_NAME,
  SAVE_MEMORY_TOOL_NAME,
  SAVE_WORKSPACE_FILE_TOOL_NAME,
  SEARCH_MEMORY_TOOL_NAME,
  selectToolsForPromptBudget,
} from './core/tier1Tools';
import {
  computeUtf8Bytes,
  formatWorkspaceFilesCatalogForPrompt,
  upsertWorkspaceFile,
  workspaceFileToArtifact,
} from './core/workspaceFiles';
import {
  countLines,
  CREATE_FILE_TOOL_NAME,
  DuplicateFileCodeFilter,
  executeCreateFileTool,
  formatTitleFromFilename,
  inferLanguageFromFilename,
  normalizeToolArgumentsJsonString,
  parseToolArgumentsJson,
} from './core/tools';
import {
  getEffectiveContextLimit,
  type AppSettings,
  type AttachedFileAttachment,
  type BackendType,
  type ChatMessage,
  type ContextSegmentKey,
  type DiagnosticEntry,
  type GeneratedFileArtifact,
  type MemoryNote,
  type ModelProfile,
  type NavigationTab,
  type PersistedWorkspace,
  type PromptInspection,
  type Session,
  type ToolCallRecord,
  type ToolDefinition,
  type WorkerStatus,
  type WorkspaceFile,
} from './core/types';

const MAX_TOOL_ROUNDS = 8;

const CORE_SYSTEM_INSTRUCTION =
  'You are LowCon, a private, deterministic assistant running on this device. Respect all pinned project rules, cite local memory when relevant, and keep responses accurate and concise.';

export function buildEffectiveCoreInstruction(
  settings: AppSettings,
  activeTools: ToolDefinition[],
  workspaceFiles: WorkspaceFile[] = [],
): string {
  const parts: string[] = [CORE_SYSTEM_INSTRUCTION];
  const username = settings.userProfile?.username?.trim();
  if (username) {
    parts.push(
      `[User Profile]\nThe user's name is "${username}". Address them by this name when appropriate.`,
    );
  }
  const customSystemPrompt = settings.userProfile?.customSystemPrompt?.trim();
  if (customSystemPrompt) {
    parts.push(`[Custom System Prompt]\n${customSystemPrompt}`);
  }
  const toolPolicy = buildToolPolicyForTools(activeTools);
  if (toolPolicy) parts.push(toolPolicy);
  const filesCatalog = formatWorkspaceFilesCatalogForPrompt(
    workspaceFiles,
    settings.allowAiFileEdits,
  );
  if (filesCatalog) parts.push(filesCatalog);
  if (settings.promptEffortEnabled) {
    const effortPrompt = settings.promptEffortPrompts?.[settings.effortLevel]?.trim();
    if (effortPrompt) {
      parts.push(`[Reasoning Effort: ${settings.effortLevel.toUpperCase()}]\n${effortPrompt}`);
    }
  }
  return parts.join('\n\n');
}

function formatUserMessageWithAttachment(
  rawText: string,
  attachedFile: AttachedFileAttachment | null,
): string {
  if (!attachedFile) return rawText;
  const { promptBlock } = formatAttachedFileForPrompt(attachedFile);
  return rawText ? `${rawText}\n\n${promptBlock}` : promptBlock;
}

function mapSessionHistoryTurns(messages: ChatMessage[]): ConversationTurnCandidate[] {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.isError && m.content.trim())
    .map((m) => {
      let content = m.content;
      if (
        m.role === 'user' &&
        m.attachedFiles &&
        m.attachedFiles.length > 0 &&
        !content.includes('[Attached local file')
      ) {
        content = formatUserMessageWithAttachment(content, m.attachedFiles[0]);
      } else if (m.role === 'assistant' && m.generatedFiles && m.generatedFiles.length > 0) {
        const fileSummary = m.generatedFiles
          .map((f) => `${f.filename} (${f.language}, ${countLines(f.content)} lines)`)
          .join(', ');
        content = `${content}\n\n[Session generated files (use read_attached_chunk to inspect lines, edit_file to patch): ${fileSummary}]`;
      }
      return {
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content,
      };
    });
}

function takeNextWordChunk(
  queue: string,
  maxWords: number,
  flushPartial: boolean,
): { chunk: string; rest: string } {
  if (!queue) return { chunk: '', rest: '' };
  let cursor = 0;
  let wordsTaken = 0;

  while (cursor < queue.length && wordsTaken < maxWords) {
    const remaining = queue.slice(cursor);
    const match = /^(\s*\S+\s+|\s+)/.exec(remaining);
    if (match) {
      cursor += match[0].length;
      wordsTaken += 1;
    } else {
      if (flushPartial || remaining.length >= 24) {
        cursor = queue.length;
      }
      break;
    }
  }

  return {
    chunk: queue.slice(0, cursor),
    rest: queue.slice(cursor),
  };
}

function buildLivePreviewInspection(
  session: Session | undefined,
  activeModel: ModelProfile | undefined,
  memoryNotes: MemoryNote[],
  workspaceFiles: WorkspaceFile[],
  settings: AppSettings,
  composerText: string,
  attachedFile: { name: string; content: string } | null,
): { inspection: PromptInspection; previewWarning: string | null } {
  const effectiveLimit = getEffectiveContextLimit(activeModel, settings.contextLimitOverride);
  const templateType = activeModel?.chatTemplate ?? 'ChatML';
  const sessionId = session?.id;

  const nonSummaryNotes = memoryNotes.filter((n) => !n.isSummary);
  const pinnedNotes = getPinnedNotesForPrompt(nonSummaryNotes, sessionId);
  const queryBasis =
    composerText.trim() ||
    [...(session?.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ||
    session?.title ||
    'context budget';

  const retrievedScored = settings.memoryRetrievalEnabled
    ? retrieveMemoryNotes(nonSummaryNotes, {
        query: queryBasis,
        sessionId,
        excludePinned: true,
        requireApproved: true,
        limit: 6,
      })
    : [];

  const summaries = buildSummaryCandidates(memoryNotes, sessionId);
  const historyTurns = mapSessionHistoryTurns(session?.messages ?? []);

  const rawDraft = composerText.trim();
  const previewUserMsg = formatUserMessageWithAttachment(rawDraft, attachedFile);

  const hasAttachments =
    Boolean(attachedFile) || Boolean(session?.messages.some((m) => (m.attachedFiles?.length ?? 0) > 0));
  const hasGeneratedFiles = Boolean(session?.messages.some((m) => (m.generatedFiles?.length ?? 0) > 0));
  const selectedTools = selectToolsForPromptBudget(effectiveLimit, {
    hasAttachments,
    hasGeneratedFiles,
    hasWorkspaceFiles: workspaceFiles.length > 0,
    includeWorkspaceFileTool: hasExplicitWorkspaceFileSaveIntent(rawDraft),
    allowAiFileEdits: settings.allowAiFileEdits,
  });

  const candidates: AssemblyCandidates = {
    coreInstruction: buildEffectiveCoreInstruction(settings, selectedTools, workspaceFiles),
    currentUserMessage: previewUserMsg,
    pinnedFacts: pinnedNotes.map((n) => ({
      id: n.id,
      title: n.title,
      content: n.content,
      sourceReference: n.sourceReference,
    })),
    taskState: session?.taskGoal ? { goal: session.taskGoal } : undefined,
    retrievedMemories: retrievedScored.map((s) => ({
      id: s.note.id,
      title: s.note.title,
      excerpt: s.note.content,
      sourceMessageId: s.note.sourceMessageIds[0],
      relevanceScore: s.finalScore,
      isPinned: false,
    })),
    conversationTurns: historyTurns,
    summaries,
    ...(selectedTools.length > 0 ? { tools: selectedTools } : {}),
  };

  const result = assembleContext(candidates, {
    modelContextLimit: effectiveLimit,
    outputReservePct: settings.outputReservePct,
    safetyMarginPct: settings.safetyMarginPct,
    templateType,
    allowEmptyUserMessage: true,
  });

  if (result.ok) {
    return { inspection: result.inspection, previewWarning: null };
  }

  // Fallback inspection solely for read-only idle preview if user shrinks slider below pinned rules
  const fallback = assembleContext(
    {
      coreInstruction: CORE_SYSTEM_INSTRUCTION,
      currentUserMessage: '',
      pinnedFacts: [],
      retrievedMemories: [],
      conversationTurns: [],
      summaries: [],
    },
    {
      modelContextLimit: Math.max(512, effectiveLimit),
      outputReservePct: Math.min(50, Math.max(5, settings.outputReservePct)),
      safetyMarginPct: Math.min(25, Math.max(2, settings.safetyMarginPct)),
      templateType,
      allowEmptyUserMessage: true,
    },
  );
  if (fallback.ok) {
    return { inspection: fallback.inspection, previewWarning: result.message };
  }
  const emergency = assembleContext(
    {
      coreInstruction: '',
      currentUserMessage: '',
      pinnedFacts: [],
      retrievedMemories: [],
      conversationTurns: [],
      summaries: [],
    },
    {
      modelContextLimit: 2048,
      outputReservePct: 20,
      safetyMarginPct: 5,
      templateType,
      allowEmptyUserMessage: true,
    },
  );
  if (emergency.ok) {
    return { inspection: emergency.inspection, previewWarning: result.message };
  }
  throw new Error(fallback.message);
}

export const App: React.FC = () => {
  const loggerRef = useRef<DiagnosticLogger | null>(null);
  if (!loggerRef.current) {
    loggerRef.current = new DiagnosticLogger('disabled');
  }
  const logger = loggerRef.current;

  const [vaultLocked, setVaultLocked] = useState<boolean>(() => isVaultSealed());
  const [vaultModeActive, setVaultModeActive] = useState<boolean>(() => isVaultModeActive());
  const [bannerError, setBannerError] = useState<string | null>(null);
  const initialStorageWarningRef = useRef<string | null>(null);

  const [workspace, setWorkspace] = useState<PersistedWorkspace>(() => {
    if (isVaultSealed()) {
      return createDefaultWorkspace();
    }
    const loaded = loadUnsealedWorkspace(logger);
    if (loaded.storageWarning) {
      initialStorageWarningRef.current = loaded.storageWarning;
    }
    return loaded.workspace;
  });

  useEffect(() => {
    if (initialStorageWarningRef.current) {
      setBannerError(initialStorageWarningRef.current);
      initialStorageWarningRef.current = null;
    }
  }, []);

  const [currentTab, setCurrentTab] = useState<NavigationTab>('chat');
  const [rightSidebarTab, setRightSidebarTab] = useState<RightSidebarTab>('context');
  const [sidebarLayout, setSidebarLayout] = useState<SidebarLayoutState>(() =>
    loadSidebarLayoutState(),
  );
  useEffect(() => {
    saveSidebarLayoutState(sidebarLayout);
  }, [sidebarLayout]);

  const handleToggleLeftSidebar = useCallback(() => {
    setSidebarLayout((prev) => ({ ...prev, leftOpen: !prev.leftOpen }));
  }, []);

  const handleToggleRightSidebar = useCallback(() => {
    setSidebarLayout((prev) => ({ ...prev, rightOpen: !prev.rightOpen }));
  }, []);

  const handleResizeLeftSidebar = useCallback((nextWidth: number) => {
    setSidebarLayout((prev) => ({
      ...prev,
      leftWidth: clampLeftSidebarWidth(nextWidth),
    }));
  }, []);

  const handleResizeRightSidebar = useCallback((nextWidth: number) => {
    setSidebarLayout((prev) => ({
      ...prev,
      rightWidth: clampRightSidebarWidth(nextWidth),
    }));
  }, []);
  const [composerText, setComposerText] = useState('');
  const [attachedFile, setAttachedFile] = useState<{ name: string; content: string } | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<ContextSegmentKey | null>(null);
  const [showPromptInspector, setShowPromptInspector] = useState(false);
  const [activeSources, setActiveSources] = useState<string[] | null>(null);
  const [previewFile, setPreviewFile] = useState<{
    file: GeneratedFileArtifact;
    sessionId: string;
    workspaceFileId?: string;
  } | null>(null);
  const [lastTurnInspection, setLastTurnInspection] = useState<PromptInspection | null>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>({ state: 'unloaded' });
  const [generatingSessionId, setGeneratingSessionId] = useState<string | null>(null);
  const [queuedRequest, setQueuedRequest] = useState<{
    sessionId: string;
    rawInput: string;
    attachedFile: AttachedFileAttachment | null;
  } | null>(null);
  const [liveTokensPerSecond, setLiveTokensPerSecond] = useState<number | null>(null);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [diagnosticEntries, setDiagnosticEntries] = useState<DiagnosticEntry[]>(() =>
    logger.getEntries(),
  );
  const [requestedMemoryFilter, setRequestedMemoryFilter] = useState<{
    filter: MemoryFilter;
    seq: number;
  } | null>(null);
  const manuallyUnloadedRef = useRef(false);
  const pausedQueueOnStopRef = useRef(false);
  const activeDripCleanupRef = useRef<(() => void) | null>(null);
  const pendingUnloadRef = useRef<Promise<unknown> | null>(null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  useEffect(() => {
    let unloadedForExit = false;
    const handleExitUnload = () => {
      if (unloadedForExit) return;
      unloadedForExit = true;
      controllerRef.current?.cancelGeneration();
      controllerRef.current?.unloadModel();

      const settings = workspaceRef.current.settings;
      const candidateModels = [
        settings.selectedLmModel,
        ...settings.connectedLmModels,
      ].filter((m) => typeof m === 'string' && m.trim().length > 0);
      if (settings.activeBackendType === 'lm_studio' || candidateModels.length > 0) {
        void unloadLocalLmModels(settings.lmStudioEndpoint, candidateModels, { beacon: true });
      }
    };

    window.addEventListener('pagehide', handleExitUnload);
    window.addEventListener('beforeunload', handleExitUnload);
    return () => {
      window.removeEventListener('pagehide', handleExitUnload);
      window.removeEventListener('beforeunload', handleExitUnload);
      activeDripCleanupRef.current?.();
    };
  }, []);

  // Subscribe to diagnostic logger updates and apply active theme variables
  useEffect(() => {
    applyThemeToDocument(workspace.settings.theme);
    if (!vaultLocked) {
      saveThemePreference(workspace.settings.theme);
    }
  }, [workspace.settings.theme, vaultLocked]);

  useEffect(() => {
    logger.setLevel(workspace.settings.diagnosticLevel);
  }, [logger, workspace.settings.diagnosticLevel]);

  useEffect(() => {
    return logger.subscribe(() => {
      setDiagnosticEntries(logger.getEntries());
    });
  }, [logger]);

  // Persistent inference worker controller
  const controllerRef = useRef<InferenceController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new InferenceController(logger, (nextStatus) => {
      setWorkerStatus(nextStatus);
    });
  }

  // Auto-load active model into worker whenever workspace unlocks or active model/profile changes
  const activeModel = useMemo(
    () =>
      workspace.models.find((m) => m.id === workspace.activeModelId) ?? workspace.models[0],
    [workspace.models, workspace.activeModelId],
  );

  const activeSession = useMemo(
    () =>
      workspace.sessions.find((s) => s.id === workspace.activeSessionId) ?? workspace.sessions[0],
    [workspace.sessions, workspace.activeSessionId],
  );

  useEffect(() => {
    if (vaultLocked || !activeModel || !controllerRef.current || manuallyUnloadedRef.current) return;
    const loaded = controllerRef.current.getLoadedModel();
    const effectiveCtx = getEffectiveContextLimit(
      activeModel,
      workspace.settings.contextLimitOverride,
    );
    const shouldReload =
      !loaded ||
      loaded.id !== activeModel.id ||
      loaded.backendType !== activeModel.backendType ||
      loaded.filePath !== activeModel.filePath ||
      loaded.chatTemplate !== activeModel.chatTemplate ||
      (loaded.contextOverride ?? loaded.contextLimit) !== effectiveCtx;

    if (shouldReload && controllerRef.current.getStatus().state !== 'generating') {
      const res = controllerRef.current.loadModel({
        ...activeModel,
        contextOverride: effectiveCtx,
      });
      if (!res.ok) {
        setBannerError(res.error);
      }
    }
  }, [
    vaultLocked,
    activeModel,
    workspace.settings.contextLimitOverride,
  ]);

  // Persist workspace reliably on every state change (encrypted directly to ciphertext when vault mode is active)
  useEffect(() => {
    if (vaultLocked) return;
    let cancelled = false;
    void persistActiveWorkspace(workspace, logger).then((res) => {
      if (!cancelled && !res.ok) {
        setBannerError(res.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, vaultLocked, logger]);

  // Compute live preview inspection when composer/memory/settings change so ContextPanel & Inspector are NEVER stale/fake
  const { inspection: activeInspection, previewWarning } = useMemo(() => {
    if (
      lastTurnInspection &&
      !composerText.trim() &&
      !attachedFile &&
      activeSession &&
      activeSession.messages.length > 0 &&
      generatingSessionId === activeSession.id
    ) {
      return { inspection: lastTurnInspection, previewWarning: null };
    }
    return buildLivePreviewInspection(
      activeSession,
      activeModel,
      workspace.memoryNotes,
      workspace.workspaceFiles,
      workspace.settings,
      composerText,
      attachedFile,
    );
  }, [
    lastTurnInspection,
    composerText,
    attachedFile,
    activeSession,
    generatingSessionId,
    activeModel,
    workspace.memoryNotes,
    workspace.workspaceFiles,
    workspace.settings,
  ]);

  const activeTurnBudget = useMemo(
    () => buildTurnContextBudget(activeInspection),
    [activeInspection],
  );

  const triggerLmStudioUnloadAll = useCallback(
    (settings: AppSettings) => {
      const candidateModels = [
        settings.selectedLmModel,
        ...settings.connectedLmModels,
      ].filter((m) => typeof m === 'string' && m.trim().length > 0);
      if (settings.activeBackendType !== 'lm_studio' && candidateModels.length === 0) {
        return null;
      }
      const unloadPromise = unloadLocalLmModels(settings.lmStudioEndpoint, candidateModels, {
        logger,
      }).finally(() => {
        if (pendingUnloadRef.current === unloadPromise) {
          pendingUnloadRef.current = null;
        }
      });
      pendingUnloadRef.current = unloadPromise;
      return unloadPromise;
    },
    [logger],
  );

  const handleSelectActiveModel = useCallback(
    (modelId: string) => {
      manuallyUnloadedRef.current = false;
      setBannerError(null);
      setLastTurnInspection(null);
      const currentWorkspace = workspaceRef.current;
      const prevModel =
        currentWorkspace.models.find((m) => m.id === currentWorkspace.activeModelId) ??
        currentWorkspace.models[0];
      const nextModel = currentWorkspace.models.find((m) => m.id === modelId);
      if (
        prevModel?.backendType === 'lm_studio' &&
        nextModel &&
        nextModel.id !== prevModel.id
      ) {
        triggerLmStudioUnloadAll(currentWorkspace.settings);
      }
      if (controllerRef.current?.isLoaded() && controllerRef.current.getLoadedModel()?.id !== modelId) {
        controllerRef.current.unloadModel();
      }
      setWorkspace((prev) => {
        const target = prev.models.find((m) => m.id === modelId);
        if (!target) return prev;
        return {
          ...prev,
          activeModelId: modelId,
          settings: {
            ...prev.settings,
            activeBackendType: target.backendType,
          },
        };
      });
    },
    [triggerLmStudioUnloadAll],
  );

  const handleLoadModel = useCallback(
    (modelId: string) => {
      manuallyUnloadedRef.current = false;
      setBannerError(null);
      const target = workspace.models.find((m) => m.id === modelId);
      if (!target || !controllerRef.current) return;
      const effectiveCtx = getEffectiveContextLimit(
        target,
        workspace.settings.contextLimitOverride,
      );
      const res = controllerRef.current.loadModel({
        ...target,
        contextOverride: effectiveCtx,
      });
      if (!res.ok) {
        setBannerError(res.error);
      }
    },
    [workspace.models, workspace.settings.contextLimitOverride],
  );

  const handleUnloadModel = useCallback(() => {
    manuallyUnloadedRef.current = true;
    controllerRef.current?.unloadModel();
    setGeneratingSessionId(null);
    triggerLmStudioUnloadAll(workspaceRef.current.settings);
  }, [triggerLmStudioUnloadAll]);

  const handleSwitchBackend = useCallback(
    (backend: BackendType) => {
      manuallyUnloadedRef.current = false;
      setBannerError(null);
      setLastTurnInspection(null);
      const settings = workspaceRef.current.settings;
      if (settings.activeBackendType === 'lm_studio' && backend !== 'lm_studio') {
        triggerLmStudioUnloadAll(settings);
      }
      setWorkspace((prev) => {
        const matchingModel = prev.models.find((m) => m.backendType === backend);
        return {
          ...prev,
          activeModelId: matchingModel ? matchingModel.id : prev.activeModelId,
          settings: {
            ...prev.settings,
            activeBackendType: backend,
          },
        };
      });
    },
    [triggerLmStudioUnloadAll],
  );

  const handleNewSession = useCallback(() => {
    const now = Date.now();
    const id = createUuid();
    const newSession: Session = {
      id,
      title: 'New local session',
      subtitle: 'Clean context window. History and memory stay strictly on this device.',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    setLastTurnInspection(null);
    setPreviewFile(null);
    setWorkspace((prev) => ({
      ...prev,
      sessions: [newSession, ...prev.sessions],
      activeSessionId: id,
    }));
    setCurrentTab('chat');
  }, []);

  const handleSelectSession = useCallback((sessionId: string) => {
    setLastTurnInspection(null);
    setPreviewFile((curr) => (curr && curr.sessionId === sessionId ? curr : null));
    setWorkspace((prev) => ({
      ...prev,
      activeSessionId: sessionId,
    }));
    setCurrentTab('chat');
  }, []);

  const handleDeleteSession = useCallback((sessionId: string) => {
    setLastTurnInspection(null);
    setPreviewFile((curr) => (curr && curr.sessionId === sessionId ? null : curr));
    setQueuedRequest((curr) => (curr && curr.sessionId === sessionId ? null : curr));
    setWorkspace((prev) => {
      const remaining = prev.sessions.filter((s) => s.id !== sessionId);
      if (remaining.length === 0) return prev;
      const nextActive =
        prev.activeSessionId === sessionId ? remaining[0].id : prev.activeSessionId;
      return {
        ...prev,
        sessions: remaining,
        activeSessionId: nextActive,
      };
    });
  }, []);

  const dispatchChatTurn = useCallback(
    async (params: {
      sessionId: string;
      rawInput: string;
      attachedFile: AttachedFileAttachment | null;
      truncateFromMessageId?: string;
      continueAssistantMessageId?: string;
      clearComposer?: boolean;
    }) => {
      const currentWs = workspaceRef.current;
      const targetSession = currentWs.sessions.find((s) => s.id === params.sessionId);
      const currentModel =
        currentWs.models.find((m) => m.id === currentWs.activeModelId) ?? currentWs.models[0];
      const rawInput = params.rawInput.trim();
      const currentAttachedFile = params.attachedFile;
      if (
        (!rawInput && !currentAttachedFile && !params.continueAssistantMessageId) ||
        !targetSession ||
        !currentModel ||
        !controllerRef.current
      ) {
        return;
      }

      setBannerError(null);
      pausedQueueOnStopRef.current = false;

      const continueIdx = params.continueAssistantMessageId
        ? targetSession.messages.findIndex(
            (m) => m.id === params.continueAssistantMessageId && m.role === 'assistant',
          )
        : -1;
      if (params.continueAssistantMessageId && continueIdx < 0) {
        return;
      }
      const continueTargetMsg = continueIdx >= 0 ? targetSession.messages[continueIdx] : null;

      const truncateIdx = params.truncateFromMessageId
        ? targetSession.messages.findIndex((m) => m.id === params.truncateFromMessageId)
        : -1;
      const priorMessages =
        continueIdx >= 0
          ? targetSession.messages.slice(0, continueIdx)
          : truncateIdx >= 0
            ? targetSession.messages.slice(0, truncateIdx)
            : targetSession.messages;

      const userContent = formatUserMessageWithAttachment(rawInput, currentAttachedFile);
      const existingVisibleText = continueTargetMsg?.content ?? '';
      const existingThinkingText = continueTargetMsg?.thinkingContent ?? '';
      const isThinkingHandoffResume =
        Boolean(continueTargetMsg) &&
        existingVisibleText.trim().length === 0 &&
        existingThinkingText.trim().length > 0;

      const targetSessionId = targetSession.id;
      const effectiveLimit = getEffectiveContextLimit(
        currentModel,
        currentWs.settings.contextLimitOverride,
      );

      // 1. Ensure model is loaded into worker before assembling/sending
      if (!controllerRef.current.isLoaded()) {
        manuallyUnloadedRef.current = false;
        const loadRes = controllerRef.current.loadModel({
          ...currentModel,
          contextOverride: effectiveLimit,
        });
        if (!loadRes.ok) {
          setBannerError(loadRes.error);
          return;
        }
      }

      // 2. Fetch pinned project rules UNCONDITIONALLY (fixes keyword-gated pin bug)
      const nonSummaryNotes = currentWs.memoryNotes.filter((n) => !n.isSummary);
      const pinnedNotes = getPinnedNotesForPrompt(nonSummaryNotes, targetSessionId);

      // 3. Fetch unpinned relevant memories via BM25 FTS across ALL notes
      const retrievedScored = currentWs.settings.memoryRetrievalEnabled
        ? retrieveMemoryNotes(nonSummaryNotes, {
            query: userContent,
            sessionId: targetSessionId,
            excludePinned: true,
            requireApproved: true,
            limit: 8,
          })
        : [];

      const summaryCandidates = buildSummaryCandidates(currentWs.memoryNotes, targetSessionId);
      const historyTurns = mapSessionHistoryTurns(priorMessages);
      const continuationSeedTurns: ConversationTurnCandidate[] = continueTargetMsg
        ? existingVisibleText.trim().length > 0
          ? [
              {
                id: `cont_prev_${continueTargetMsg.id}`,
                role: 'assistant',
                content: existingVisibleText,
              },
              {
                id: `cont_inst_${continueTargetMsg.id}`,
                role: 'user',
                content: buildContinuationInstruction(existingVisibleText),
              },
            ]
          : [
              {
                id: `cont_handoff_${continueTargetMsg.id}`,
                role: 'user',
                content: buildThinkingHandoffInstruction(existingThinkingText),
              },
            ]
        : [];
      let turnWorkspaceFiles = [...currentWs.workspaceFiles];
      const selectedTools = selectToolsForPromptBudget(effectiveLimit, {
        hasAttachments:
          Boolean(currentAttachedFile) ||
          priorMessages.some((m) => (m.attachedFiles?.length ?? 0) > 0),
        hasGeneratedFiles: priorMessages.some((m) => (m.generatedFiles?.length ?? 0) > 0),
        hasWorkspaceFiles: turnWorkspaceFiles.length > 0,
        includeWorkspaceFileTool: hasExplicitWorkspaceFileSaveIntent(
          continueTargetMsg
            ? priorMessages[priorMessages.length - 1]?.content ?? rawInput
            : rawInput,
        ),
        allowAiFileEdits: currentWs.settings.allowAiFileEdits,
      });

      const baseAssemblyCandidates = {
        coreInstruction: buildEffectiveCoreInstruction(
          currentWs.settings,
          selectedTools,
          turnWorkspaceFiles,
        ),
        pinnedFacts: pinnedNotes.map((n) => ({
          id: n.id,
          title: n.title,
          content: n.content,
          sourceReference: n.sourceReference,
        })),
        taskState: targetSession.taskGoal ? { goal: targetSession.taskGoal } : undefined,
        retrievedMemories: retrievedScored.map((s) => ({
          id: s.note.id,
          title: s.note.title,
          excerpt: s.note.content,
          sourceMessageId: s.note.sourceMessageIds[0],
          relevanceScore: s.finalScore,
          isPinned: false,
        })),
        summaries: summaryCandidates,
        ...(selectedTools.length > 0 ? { tools: selectedTools } : {}),
      };

      // 4. Deterministic budget-first context assembly with user's exact reserve % & model template
      const assemblyResult = continueTargetMsg
        ? assembleContext(
            {
              ...baseAssemblyCandidates,
              currentUserMessage: '',
              conversationTurns: [...historyTurns, ...continuationSeedTurns],
            },
            {
              modelContextLimit: effectiveLimit,
              outputReservePct: currentWs.settings.outputReservePct,
              safetyMarginPct: currentWs.settings.safetyMarginPct,
              templateType: currentModel.chatTemplate,
              allowEmptyUserMessage: true,
            },
          )
        : assembleContext(
            {
              ...baseAssemblyCandidates,
              currentUserMessage: userContent,
              conversationTurns: historyTurns,
            },
            {
              modelContextLimit: effectiveLimit,
              outputReservePct: currentWs.settings.outputReservePct,
              safetyMarginPct: currentWs.settings.safetyMarginPct,
              templateType: currentModel.chatTemplate,
            },
          );

      // 5. NEVER fall back to unbudgeted prompt on mandatory overflow
      if (!assemblyResult.ok) {
        logger.error('context', `Assembly aborted (${assemblyResult.code}): ${assemblyResult.message}`);
        setBannerError(assemblyResult.message);
        return;
      }

      const inspection = assemblyResult.inspection;
      const turnBudget = buildTurnContextBudget(inspection);
      setLastTurnInspection(inspection);

      const sources: string[] = [
        ...pinnedNotes.map((n) => `Pinned rule: ${n.title} (${n.sourceReference})`),
        ...retrievedScored
          .filter((s) => inspection.includedMemoryIds.includes(s.note.id))
          .map((s) => `Memory note: ${s.note.title} (${s.note.sourceReference})`),
        ...summaryCandidates
          .filter((s) => inspection.includedMemoryIds.includes(s.id))
          .map((s) => `Summary: Turns ${s.sourceTurnRange}`),
      ];

      const now = Date.now();
      const userMsgId = createUuid();
      const assistantMsgId = continueTargetMsg?.id ?? createUuid();
      const modelDisplayLabel =
        currentModel.backendType === 'lm_studio' && currentWs.settings.selectedLmModel
          ? `${resolveModelDisplayName(currentWs.settings.selectedLmModel, currentWs.settings.modelDisplayAliases)} · ${currentModel.chatTemplate}`
          : `${currentModel.name} · ${currentModel.chatTemplate}`;

      if (continueTargetMsg) {
        setWorkspace((prev) => ({
          ...prev,
          sessions: prev.sessions.map((s) => {
            if (s.id !== targetSessionId) return s;
            return {
              ...s,
              updatedAt: now,
              messages: s.messages.map((m) =>
                m.id === assistantMsgId
                  ? {
                      ...m,
                      stopReason: undefined,
                      turnBudget,
                    }
                  : m,
              ),
            };
          }),
        }));
      } else {
        const userMessage: ChatMessage = {
          id: userMsgId,
          role: 'user',
          authorName: currentWs.settings.userProfile?.username?.trim() || 'You',
          createdAt: now,
          content: rawInput,
          ...(currentAttachedFile ? { attachedFiles: [currentAttachedFile] } : {}),
          sources: [],
        };

        const assistantPlaceholder: ChatMessage = {
          id: assistantMsgId,
          role: 'assistant',
          authorName: 'LowCon',
          createdAt: now + 1,
          modelInfo: modelDisplayLabel,
          content: '',
          sources,
          turnBudget,
        };

        // Append (or replace from retry point) messages & auto-title new sessions
        setWorkspace((prev) => ({
          ...prev,
          sessions: prev.sessions.map((s) => {
            if (s.id !== targetSessionId) return s;
            const idx = params.truncateFromMessageId
              ? s.messages.findIndex((m) => m.id === params.truncateFromMessageId)
              : -1;
            const baseMsgs = idx >= 0 ? s.messages.slice(0, idx) : s.messages;
            const shouldRename =
              baseMsgs.length === 0 &&
              (s.title === 'New local session' || s.title === 'Context strategy / 8K model');
            return {
              ...s,
              title: shouldRename
                ? safeTruncateChars(rawInput || currentAttachedFile?.name || 'Attached file', 36)
                : s.title,
              updatedAt: now,
              messages: [...baseMsgs, userMessage, assistantPlaceholder],
            };
          }),
        }));
      }

      // Progressive word-by-word drip queue for visible answer text
      activeDripCleanupRef.current?.();

      if (params.clearComposer) {
        setComposerText('');
        setAttachedFile(null);
      }
      setGeneratingSessionId(targetSessionId);
      setLiveTokensPerSecond(null);

      const initialMaxTokens = computeTurnMaxTokens(
        inspection,
        currentWs.settings.expandReplyToFreeContext !== false,
      );
      logger.info(
        'chat',
        `Dispatching turn (session=${targetSessionId.slice(0, 8)}, packed=${inspection.totalTokens}/${inspection.budgetPartition.promptBudget}, max_tokens=${initialMaxTokens}, reserve=${inspection.budgetPartition.outputReserve}, pinned=${pinnedNotes.length}, retrieved=${retrievedScored.length})`,
      );

      let pendingWordQueue = '';
      let thinkingStartedAt: number | null = null;
      let thinkingFinishedAt: number | null = null;
      let streamCompletion: {
        totalTokens: number;
        stopReason: StreamStopReason;
        tokensPerSecond: number;
      } | null = null;
      let dripStopped = false;
      const collectedFiles: GeneratedFileArtifact[] = [
        ...(continueTargetMsg?.generatedFiles ?? []),
      ];
      const toolActivityLabels: string[] = [...(continueTargetMsg?.toolActivity ?? [])];
      const sessionAttachedFiles: AttachedFileAttachment[] = [
        ...priorMessages.flatMap((m) => m.attachedFiles ?? []),
        ...(currentAttachedFile ? [currentAttachedFile] : []),
      ];
      let sessionMemoryNotes = [...currentWs.memoryNotes];

      const getSessionGeneratedFiles = (): GeneratedFileArtifact[] => {
        const byFilename = new Map<string, GeneratedFileArtifact>();
        for (const msg of priorMessages) {
          for (const file of msg.generatedFiles ?? []) {
            byFilename.set(file.filename.toLowerCase(), file);
          }
        }
        for (const file of collectedFiles) {
          byFilename.set(file.filename.toLowerCase(), file);
        }
        return Array.from(byFilename.values());
      };

    const upsertCollectedFile = (artifact: GeneratedFileArtifact) => {
      const existingIdx = collectedFiles.findIndex(
        (f) => f.id === artifact.id || f.filename.toLowerCase() === artifact.filename.toLowerCase(),
      );
      if (existingIdx !== -1) {
        collectedFiles[existingIdx] = artifact;
      } else {
        collectedFiles.push(artifact);
      }
    };

    const updateAssistantMessage = (updater: (m: ChatMessage) => ChatMessage) => {
      setWorkspace((prev) => ({
        ...prev,
        sessions: prev.sessions.map((s) => {
          if (s.id !== targetSessionId) return s;
          return {
            ...s,
            updatedAt: Date.now(),
            messages: s.messages.map((m) => (m.id === assistantMsgId ? updater(m) : m)),
          };
        }),
      }));
    };

    const finalizeStream = (completion: NonNullable<typeof streamCompletion>) => {
      const thinkingDurationMs =
        thinkingStartedAt !== null
          ? Math.max(100, (thinkingFinishedAt ?? performance.now()) - thinkingStartedAt)
          : undefined;
      updateAssistantMessage((m) => {
        const cleaned = m.content.replace(/\n{3,}/g, '\n\n').trim();
        const fileActionVerb = collectedFiles.every((f) => f.isEdited) ? 'Updated' : 'Created';
        const fallbackSummary =
          !cleaned && collectedFiles.length > 0
            ? `${fileActionVerb} ${collectedFiles.map((f) => `\`${f.filename}\``).join(', ')}. Open the file card below to preview, copy, or download.`
            : cleaned;
        return {
          ...m,
          content: fallbackSummary,
          tokenCount: completion.totalTokens,
          tokensPerSecond:
            completion.tokensPerSecond > 0 ? completion.tokensPerSecond : m.tokensPerSecond,
          stopReason: completion.stopReason,
          thinkingDurationMs: thinkingDurationMs ?? m.thinkingDurationMs,
          ...(collectedFiles.length > 0 ? { generatedFiles: [...collectedFiles] } : {}),
          ...(toolActivityLabels.length > 0 ? { toolActivity: [...toolActivityLabels] } : {}),
        };
      });
      setLiveTokensPerSecond(null);
      setLastTurnInspection(null);
      setGeneratingSessionId((curr) => (curr === targetSessionId ? null : curr));
    };

    const dripTimer = setInterval(() => {
      if (dripStopped) return;

      if (pendingWordQueue.length > 0) {
        const wordsPerTick =
          pendingWordQueue.length > 240
            ? 5
            : pendingWordQueue.length > 100
              ? 3
              : pendingWordQueue.length > 40
                ? 2
                : 1;
        const { chunk, rest } = takeNextWordChunk(
          pendingWordQueue,
          wordsPerTick,
          streamCompletion !== null,
        );
        pendingWordQueue = rest;

        if (chunk) {
          updateAssistantMessage((m) => ({ ...m, content: m.content + chunk }));
        }
      }

      if (streamCompletion && pendingWordQueue.length === 0) {
        stopDrip();
        finalizeStream(streamCompletion);
      }
    }, 22);

    const handleCancelDrip = () => {
      dripStopped = true;
      clearInterval(dripTimer);
      pendingWordQueue = '';
      if (activeDripCleanupRef.current === handleCancelDrip) {
        activeDripCleanupRef.current = null;
      }
      setLiveTokensPerSecond(null);
      updateAssistantMessage((m) => ({
        ...m,
        content: m.content
          ? `${m.content}\n\n[Generation stopped by user]`
          : '[Generation stopped by user]',
      }));
      setGeneratingSessionId((curr) => (curr === targetSessionId ? null : curr));
    };

    const stopDrip = () => {
      dripStopped = true;
      clearInterval(dripTimer);
      pendingWordQueue = '';
      if (
        activeDripCleanupRef.current === stopDrip ||
        activeDripCleanupRef.current === handleCancelDrip
      ) {
        activeDripCleanupRef.current = null;
      }
    };
    activeDripCleanupRef.current = stopDrip;

    type StepOutcome =
      | {
          status: 'complete';
          totalTokens: number;
          stopReason: StreamStopReason;
          tokensPerSecond: number;
          toolCalls?: ToolCallRecord[];
          rawText: string;
          dedupedText: string;
        }
      | { status: 'thinking_guard'; rawThinking: string }
      | { status: 'cancelled' }
      | { status: 'error'; message: string };

    const assembleWithCompaction = (
      turnCandidates: ConversationTurnCandidate[],
      compactedCandidateTurns?: ConversationTurnCandidate[],
    ) => {
      const baseOptions = {
        modelContextLimit: effectiveLimit,
        outputReservePct: currentWs.settings.outputReservePct,
        safetyMarginPct: currentWs.settings.safetyMarginPct,
        templateType: currentModel.chatTemplate,
        allowEmptyUserMessage: true,
      };
      let next = assembleContext(
        {
          ...baseAssemblyCandidates,
          currentUserMessage: '',
          conversationTurns: [...historyTurns, ...turnCandidates],
        },
        baseOptions,
      );
      if (!next.ok && next.code === 'MANDATORY_EXCEEDS_BUDGET' && compactedCandidateTurns) {
        next = assembleContext(
          {
            ...baseAssemblyCandidates,
            currentUserMessage: '',
            conversationTurns: [...historyTurns, ...compactedCandidateTurns],
          },
          baseOptions,
        );
      }
      if (!next.ok && next.code === 'MANDATORY_EXCEEDS_BUDGET') {
        const distilled = distillOlderToolTurns(compactedCandidateTurns ?? turnCandidates, 2);
        next = assembleContext(
          {
            ...baseAssemblyCandidates,
            currentUserMessage: '',
            conversationTurns: [...historyTurns, ...distilled],
          },
          baseOptions,
        );
      }
      return next;
    };

    const runStep = (
      stepInspection: PromptInspection,
      isFinalRound: boolean,
      stepOptions?: {
        reasoningEffortOverride?: 'low' | 'medium' | 'high';
        allowThinkingGuard?: boolean;
        stripOverlapFromExisting?: string;
      },
    ): Promise<StepOutcome> =>
      new Promise((resolve) => {
        let stepRawText = '';
        let stepDedupedText = '';
        let stepThinkingText = '';
        let guardAborted = false;
        let overlapBuffer = '';
        let overlapResolved = !stepOptions?.stripOverlapFromExisting;
        const stepMaxTokens = computeTurnMaxTokens(
          stepInspection,
          workspaceRef.current.settings.expandReplyToFreeContext !== false,
        );

        const pushVisibleChunk = (text: string) => {
          if (!text) return;
          stepDedupedText += text;
          codeFilter.push(text);
        };

        const codeFilter = new DuplicateFileCodeFilter(
          () => collectedFiles,
          (filteredText) => {
            if (!dripStopped && filteredText) {
              pendingWordQueue += filteredText;
            }
          },
        );
        void controllerRef.current!.startGeneration(
          targetSessionId,
          {
            exactRenderedPrompt: stepInspection.exactRenderedPrompt,
            structuredMessages: stepInspection.structuredMessages,
            maxTokens: stepMaxTokens,
            temperature: 0.7,
            topP: 0.9,
            stopSequences: stopSequencesForTemplate(currentModel.chatTemplate),
            lmStudioEndpoint: workspaceRef.current.settings.lmStudioEndpoint,
            selectedLmModel: workspaceRef.current.settings.selectedLmModel,
            reasoningEffort:
              stepOptions?.reasoningEffortOverride ??
              (workspaceRef.current.settings.promptEffortEnabled
                ? undefined
                : workspaceRef.current.settings.effortLevel),
            tools: stepInspection.tools,
            toolChoice: stepInspection.tools?.length
              ? isFinalRound
                ? 'none'
                : 'auto'
              : undefined,
          },
          {
            onThinkingToken: (token) => {
              if (dripStopped || guardAborted) return;
              if (thinkingStartedAt === null) {
                thinkingStartedAt = performance.now();
              }
              stepThinkingText += token;
              currentTurnThinkingText += token;
              updateAssistantMessage((m) => ({
                ...m,
                thinkingContent: (m.thinkingContent ?? '') + token,
              }));

              if (
                stepOptions?.allowThinkingGuard &&
                workspaceRef.current.settings.thinkingGuardEnabled === true &&
                stepMaxTokens >= 256 &&
                !stepRawText.trim()
              ) {
                const estThinkingTokens = Math.ceil(stepThinkingText.length / 3.5);
                if (estThinkingTokens >= Math.floor(stepMaxTokens * THINKING_GUARD_RATIO)) {
                  guardAborted = true;
                  controllerRef.current?.cancelGeneration();
                }
              }
            },
            onToolCallDetected: (toolName) => {
              if (dripStopped) return;
              const label = getToolPendingActivityLabel(toolName);
              updateAssistantMessage((m) => ({
                ...m,
                toolActivity: [...toolActivityLabels, label],
              }));
            },
            onToken: (token) => {
              if (dripStopped || guardAborted) return;
              if (thinkingStartedAt !== null && thinkingFinishedAt === null && token.trim()) {
                thinkingFinishedAt = performance.now();
              }
              stepRawText += token;
              if (!overlapResolved && stepOptions?.stripOverlapFromExisting) {
                overlapBuffer += token;
                if (overlapBuffer.length >= 120 || overlapBuffer.includes('\n')) {
                  overlapResolved = true;
                  const deduped = dedupeContinuationOverlap(
                    stepOptions.stripOverlapFromExisting,
                    overlapBuffer,
                  );
                  overlapBuffer = '';
                  pushVisibleChunk(deduped);
                }
              } else {
                pushVisibleChunk(token);
              }
            },
            onProgress: (progress) => {
              if (dripStopped) return;
              if (progress.tokensPerSecond > 0) {
                setLiveTokensPerSecond(progress.tokensPerSecond);
                updateAssistantMessage((m) => ({
                  ...m,
                  tokensPerSecond: progress.tokensPerSecond,
                }));
              }
            },
            onComplete: (totalTokens, stopReason, stats) => {
              if (!overlapResolved && overlapBuffer.length > 0 && stepOptions?.stripOverlapFromExisting) {
                overlapResolved = true;
                const deduped = dedupeContinuationOverlap(
                  stepOptions.stripOverlapFromExisting,
                  overlapBuffer,
                );
                overlapBuffer = '';
                pushVisibleChunk(deduped);
              }
              codeFilter.flush();
              resolve({
                status: 'complete',
                totalTokens,
                stopReason,
                tokensPerSecond: stats?.tokensPerSecond ?? 0,
                toolCalls: stats?.toolCalls,
                rawText: stepRawText,
                dedupedText: stepDedupedText,
              });
            },
            onCancelled: () => {
              if (guardAborted) {
                resolve({ status: 'thinking_guard', rawThinking: stepThinkingText });
                return;
              }
              resolve({ status: 'cancelled' });
            },
            onError: (message) => {
              if (!overlapResolved && overlapBuffer.length > 0 && stepOptions?.stripOverlapFromExisting) {
                overlapResolved = true;
                const deduped = dedupeContinuationOverlap(
                  stepOptions.stripOverlapFromExisting,
                  overlapBuffer,
                );
                overlapBuffer = '';
                pushVisibleChunk(deduped);
              }
              codeFilter.flush();
              resolve({ status: 'error', message });
            },
          },
        );
      });

    // Wait for any in-flight LM Studio model unload to complete before loading/running the next model
    if (pendingUnloadRef.current) {
      await pendingUnloadRef.current;
    }

    // 6. Execute bounded multi-turn tool + anti-stop continuation loop (session-isolated)
    const inTurnToolTurns: ConversationTurnCandidate[] = continueTargetMsg
      ? [...continuationSeedTurns]
      : [{ id: userMsgId, role: 'user', content: userContent }];
    let currentInspection = inspection;
    let cumulativeTokens = continueTargetMsg?.tokenCount ?? 0;
    let latestTps = continueTargetMsg?.tokensPerSecond ?? 0;
    const failedCallCounts = new Map<string, number>();
    let forceFinalTextRound = false;
    let accumulatedVisibleText = existingVisibleText;
    let currentTurnThinkingText = existingThinkingText;
    let autoContinuationHops = 0;
    let currentStepReasoningOverride: 'low' | 'medium' | 'high' | undefined =
      isThinkingHandoffResume ? 'low' : undefined;
    let currentStepOverlapPrefix: string | undefined =
      continueTargetMsg && existingVisibleText.trim().length > 0
        ? existingVisibleText
        : undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const outcome = await runStep(
        currentInspection,
        forceFinalTextRound || round === MAX_TOOL_ROUNDS - 1,
        {
          reasoningEffortOverride: currentStepReasoningOverride,
          allowThinkingGuard:
            !currentStepReasoningOverride && autoContinuationHops < MAX_AUTO_CONTINUATION_HOPS,
          stripOverlapFromExisting: currentStepOverlapPrefix,
        },
      );

      if (outcome.status === 'cancelled') {
        stopDrip();
        setLiveTokensPerSecond(null);
        logger.info('chat', `Generation cancelled (session=${targetSessionId.slice(0, 8)})`);
        updateAssistantMessage((m) => ({
          ...m,
          content: m.content
            ? `${m.content}\n\n[Generation stopped by user]`
            : '[Generation stopped by user]',
        }));
        setGeneratingSessionId((curr) => (curr === targetSessionId ? null : curr));
        return;
      }

      if (outcome.status === 'error') {
        stopDrip();
        setLiveTokensPerSecond(null);
        setBannerError(outcome.message);
        updateAssistantMessage((m) => ({
          ...m,
          content: outcome.message,
          isError: true,
        }));
        setGeneratingSessionId((curr) => (curr === targetSessionId ? null : curr));
        return;
      }

      if (outcome.status === 'thinking_guard') {
        logger.warn(
          'chat',
          `Live thinking guard interrupted long reasoning (round=${round + 1}); handing off to concise answer.`,
        );
        autoContinuationHops += 1;
        inTurnToolTurns.push({
          id: `handoff_guard_${round}_${createUuid().slice(0, 6)}`,
          role: 'user',
          content: buildThinkingHandoffInstruction(currentTurnThinkingText || outcome.rawThinking),
        });
        currentStepReasoningOverride = 'low';
        currentStepOverlapPrefix = undefined;
        const guardAssembly = assembleWithCompaction(inTurnToolTurns);
        if (!guardAssembly.ok) {
          stopDrip();
          setLiveTokensPerSecond(null);
          setBannerError(guardAssembly.message);
          updateAssistantMessage((m) => ({
            ...m,
            content: guardAssembly.message,
            isError: true,
          }));
          setGeneratingSessionId((curr) => (curr === targetSessionId ? null : curr));
          return;
        }
        currentInspection = guardAssembly.inspection;
        setLastTurnInspection(currentInspection);
        updateAssistantMessage((m) => ({
          ...m,
          turnBudget: buildTurnContextBudget(currentInspection),
        }));
        continue;
      }

      cumulativeTokens += outcome.totalTokens;
      if (outcome.tokensPerSecond > 0) {
        latestTps = outcome.tokensPerSecond;
      }
      if (outcome.dedupedText) {
        accumulatedVisibleText += outcome.dedupedText;
      }

      const stepTokensUsed = currentInspection.totalTokens + outcome.totalTokens;
      if (stepTokensUsed > 0) {
        setWorkspace((prev) => ({
          ...prev,
          tokenUsage: addTokenUsage(prev.tokenUsage, stepTokensUsed),
        }));
      }

      const hasToolCalls =
        outcome.stopReason === 'tool_calls' &&
        outcome.toolCalls &&
        outcome.toolCalls.length > 0 &&
        round < MAX_TOOL_ROUNDS - 1;

      if (!hasToolCalls) {
        const autoContinueEnabled =
          workspaceRef.current.settings.autoContinueOnMaxTokens !== false;
        const canAutoContinue =
          autoContinueEnabled &&
          outcome.stopReason === 'max_tokens' &&
          autoContinuationHops < MAX_AUTO_CONTINUATION_HOPS &&
          round < MAX_TOOL_ROUNDS - 1 &&
          (accumulatedVisibleText.trim().length > 0 || currentTurnThinkingText.trim().length > 0);

        if (canAutoContinue) {
          autoContinuationHops += 1;
          logger.info(
            'chat',
            `Hit max_tokens (hop ${autoContinuationHops}/${MAX_AUTO_CONTINUATION_HOPS}); running seamless ${
              accumulatedVisibleText.trim().length > 0 ? 'continuation' : 'thinking-to-answer handoff'
            }`,
          );
          if (accumulatedVisibleText.trim().length > 0) {
            inTurnToolTurns.push(
              {
                id: `cont_partial_${round}_${createUuid().slice(0, 6)}`,
                role: 'assistant',
                content: outcome.dedupedText.trim() || accumulatedVisibleText,
              },
              {
                id: `cont_inst_${round}_${createUuid().slice(0, 6)}`,
                role: 'user',
                content: buildContinuationInstruction(accumulatedVisibleText),
              },
            );
            currentStepOverlapPrefix = accumulatedVisibleText;
            currentStepReasoningOverride = undefined;
          } else {
            inTurnToolTurns.push({
              id: `handoff_inst_${round}_${createUuid().slice(0, 6)}`,
              role: 'user',
              content: buildThinkingHandoffInstruction(currentTurnThinkingText),
            });
            currentStepOverlapPrefix = undefined;
            currentStepReasoningOverride = 'low';
          }
          const contAssembly = assembleWithCompaction(inTurnToolTurns);
          if (contAssembly.ok) {
            currentInspection = contAssembly.inspection;
            setLastTurnInspection(currentInspection);
            updateAssistantMessage((m) => ({
              ...m,
              turnBudget: buildTurnContextBudget(currentInspection),
            }));
            continue;
          }
          logger.warn(
            'chat',
            `Auto-continue context assembly failed (${contAssembly.code}); finalizing current output.`,
          );
        }

        logger.info(
          'chat',
          `Generation complete (session=${targetSessionId.slice(0, 8)}, tokens=${cumulativeTokens}, stop=${outcome.stopReason}, tps=${latestTps})`,
        );
        if (thinkingStartedAt !== null && thinkingFinishedAt === null) {
          thinkingFinishedAt = performance.now();
        }
        const completion = {
          totalTokens: cumulativeTokens,
          stopReason: outcome.stopReason,
          tokensPerSecond: latestTps,
        };
        if (pendingWordQueue.length === 0) {
          stopDrip();
          finalizeStream(completion);
        } else {
          streamCompletion = completion;
          activeDripCleanupRef.current = handleCancelDrip;
        }
        return;
      }

      // Tool round succeeded — reset continuation step hints for subsequent response
      currentStepOverlapPrefix = undefined;
      currentStepReasoningOverride = undefined;

      // Discard any partial tool-preamble whitespace if nothing meaningful streamed, or let it finish naturally
      const roundToolCalls = outcome.toolCalls!;
      // Re-serialize tool_call arguments to guaranteed-valid JSON strings before echoing
      // back to LM Studio / llama.cpp on Round 2+ (prevents Jinja `fromjson` crashes).
      const normalizedRoundToolCalls: ToolCallRecord[] = roundToolCalls.map((tc) => ({
        ...tc,
        function: {
          name: tc.function.name,
          arguments: normalizeToolArgumentsJsonString(tc.function.arguments),
        },
      }));
      const compactCallsForBudget: ToolCallRecord[] = [];

      inTurnToolTurns.push({
        id: `tool_req_${round}_${createUuid().slice(0, 6)}`,
        role: 'assistant',
        content: outcome.rawText,
        toolCalls: normalizedRoundToolCalls,
      });

      for (const tc of roundToolCalls) {
        if (tc.function.name === CREATE_FILE_TOOL_NAME) {
          const exec = executeCreateFileTool(tc.function.arguments, createUuid);
          if (exec.ok) {
            upsertCollectedFile(exec.artifact);
            toolActivityLabels.push(`Created ${exec.artifact.filename}`);
            logger.info(
              'chat',
              `Tool create_file wrote file (${countLines(exec.artifact.content)} lines)`,
            );
            compactCallsForBudget.push({
              ...tc,
              function: {
                name: tc.function.name,
                arguments: JSON.stringify({
                  filename: exec.artifact.filename,
                  title: exec.artifact.title,
                  language: exec.artifact.language,
                  content: '[omitted to fit context budget]',
                }),
              },
            });
          } else {
            toolActivityLabels.push(`Failed create_file: ${exec.error}`);
            logger.warn('chat', `Tool create_file error: ${exec.error}`);
            compactCallsForBudget.push({
              ...tc,
              function: {
                name: tc.function.name,
                arguments: normalizeToolArgumentsJsonString(tc.function.arguments),
              },
            });
          }
          inTurnToolTurns.push({
            id: `tool_res_${tc.id}`,
            role: 'tool',
            toolCallId: tc.id,
            name: tc.function.name,
            content: exec.toolResultJson,
          });
        } else if (tc.function.name === EDIT_FILE_TOOL_NAME) {
          const parsedEditArgs = parseToolArgumentsJson(tc.function.arguments);
          const requestedEditName = extractEditTargetFilename(parsedEditArgs);
          const liveWorkspaceFiles = workspaceRef.current.workspaceFiles;
          const allowEditsOverall = workspaceRef.current.settings.allowAiFileEdits;
          const liveLockedMatch = requestedEditName
            ? liveWorkspaceFiles.find(
                (wf) => wf.filename.toLowerCase() === requestedEditName.toLowerCase(),
              )
            : undefined;

          // Sync any newly added or updated Files-tab entries from live state
          const turnWfById = new Map(turnWorkspaceFiles.map((wf) => [wf.id, wf]));
          for (const liveWf of liveWorkspaceFiles) {
            const existingTurnWf = turnWfById.get(liveWf.id);
            if (!existingTurnWf || liveWf.updatedAt > existingTurnWf.updatedAt) {
              turnWfById.set(liveWf.id, liveWf);
            } else if (existingTurnWf.lockedByUser !== liveWf.lockedByUser) {
              turnWfById.set(liveWf.id, { ...existingTurnWf, lockedByUser: liveWf.lockedByUser });
            }
          }
          turnWorkspaceFiles = Array.from(turnWfById.values());

          // Build editable file map across ALL local sources in precedence order:
          // 1. Chat-attached files  2. Prior generated files  3. Live Files-tab files  4. In-turn edits
          const mergedEditableByLower = new Map<string, GeneratedFileArtifact>();
          for (let attIdx = 0; attIdx < sessionAttachedFiles.length; attIdx++) {
            const att = sessionAttachedFiles[attIdx];
            mergedEditableByLower.set(att.name.toLowerCase(), {
              id: `att_${attIdx}_${att.name}`,
              filename: att.name,
              title: formatTitleFromFilename(att.name),
              language: inferLanguageFromFilename(att.name),
              content: att.content,
              createdAt: now,
            });
          }
          for (const msg of priorMessages) {
            for (const gen of msg.generatedFiles ?? []) {
              mergedEditableByLower.set(gen.filename.toLowerCase(), gen);
            }
          }
          for (const wf of turnWorkspaceFiles) {
            mergedEditableByLower.set(wf.filename.toLowerCase(), workspaceFileToArtifact(wf));
          }
          for (const file of collectedFiles) {
            mergedEditableByLower.set(file.filename.toLowerCase(), file);
          }

          let exec: ReturnType<typeof executeEditFileTool>;
          if (!allowEditsOverall) {
            const error = 'AI file edits are disabled overall in Settings.';
            exec = {
              ok: false,
              error,
              toolResultJson: JSON.stringify({ status: 'error', error }),
            };
          } else if (liveLockedMatch?.lockedByUser) {
            const error = `File '${liveLockedMatch.filename}' is locked against LLM edits in the Files tab.`;
            exec = {
              ok: false,
              error,
              toolResultJson: JSON.stringify({ status: 'error', error }),
            };
          } else {
            const candidateExec = executeEditFileTool(
              tc.function.arguments,
              Array.from(mergedEditableByLower.values()),
            );
            if (candidateExec.ok) {
              const editedFilenameLower = candidateExec.artifact.filename.toLowerCase();
              const targetWorkspaceFile = liveWorkspaceFiles.find(
                (wf) => wf.filename.toLowerCase() === editedFilenameLower,
              );
              if (targetWorkspaceFile?.lockedByUser) {
                const error = `File '${targetWorkspaceFile.filename}' is locked against LLM edits in the Files tab.`;
                exec = {
                  ok: false,
                  error,
                  toolResultJson: JSON.stringify({ status: 'error', error }),
                };
              } else {
                exec = candidateExec;
              }
            } else {
              exec = candidateExec;
            }
          }

          if (exec.ok) {
            const sourceArtifactId = exec.artifact.id;
            const matchingWorkspaceFile = turnWorkspaceFiles.find(
              (wf) => wf.filename.toLowerCase() === exec.artifact.filename.toLowerCase(),
            );
            const nowMs = Date.now();
            if (matchingWorkspaceFile) {
              const updatedWf: WorkspaceFile = {
                ...matchingWorkspaceFile,
                content: exec.artifact.content,
                sizeBytes: computeUtf8Bytes(exec.artifact.content),
                updatedAt: nowMs,
              };
              turnWorkspaceFiles = turnWorkspaceFiles.map((wf) =>
                wf.id === matchingWorkspaceFile.id ? updatedWf : wf,
              );
              setWorkspace((prev) => ({
                ...prev,
                workspaceFiles: prev.workspaceFiles.map((wf) =>
                  wf.id === matchingWorkspaceFile.id
                    ? {
                        ...wf,
                        content: exec.artifact.content,
                        sizeBytes: computeUtf8Bytes(exec.artifact.content),
                        updatedAt: nowMs,
                      }
                    : wf,
                ),
              }));
              baseAssemblyCandidates.coreInstruction = buildEffectiveCoreInstruction(
                workspaceRef.current.settings,
                selectedTools,
                turnWorkspaceFiles,
              );
            }

            const inTurnMatch = collectedFiles.find(
              (f) => f.filename.toLowerCase() === exec.artifact.filename.toLowerCase(),
            );
            const updatedArtifact: GeneratedFileArtifact = {
              ...exec.artifact,
              id: inTurnMatch ? inTurnMatch.id : `file_${createUuid().slice(0, 8)}`,
              updatedAt: nowMs,
              isEdited: true,
            };
            upsertCollectedFile(updatedArtifact);
            if (!matchingWorkspaceFile) {
              setWorkspace((prev) => ({
                ...prev,
                sessions: prev.sessions.map((s) => {
                  if (s.id !== targetSessionId) return s;
                  return {
                    ...s,
                    messages: s.messages.map((m) => {
                      if (!m.generatedFiles || m.generatedFiles.length === 0) return m;
                      const hasMatch = m.generatedFiles.some(
                        (f) =>
                          f.id === sourceArtifactId ||
                          f.filename.toLowerCase() === updatedArtifact.filename.toLowerCase(),
                      );
                      if (!hasMatch) return m;
                      return {
                        ...m,
                        generatedFiles: m.generatedFiles.map((f) =>
                          f.id === sourceArtifactId ||
                          f.filename.toLowerCase() === updatedArtifact.filename.toLowerCase()
                            ? {
                                ...f,
                                content: updatedArtifact.content,
                                updatedAt: nowMs,
                                isEdited: true,
                              }
                            : f,
                        ),
                      };
                    }),
                  };
                }),
              }));
            }
            setPreviewFile((curr) => {
              if (!curr) return curr;
              if (
                matchingWorkspaceFile &&
                curr.workspaceFileId === matchingWorkspaceFile.id
              ) {
                return {
                  ...curr,
                  file: workspaceFileToArtifact({
                    ...matchingWorkspaceFile,
                    content: exec.artifact.content,
                    sizeBytes: computeUtf8Bytes(exec.artifact.content),
                    updatedAt: nowMs,
                  }),
                };
              }
              if (
                curr.sessionId === targetSessionId &&
                (curr.file.id === sourceArtifactId ||
                  curr.file.id === updatedArtifact.id ||
                  curr.file.filename.toLowerCase() === updatedArtifact.filename.toLowerCase())
              ) {
                return { ...curr, file: updatedArtifact };
              }
              return curr;
            });
            toolActivityLabels.push(
              `Updated ${updatedArtifact.filename} (${exec.linesChanged} ${exec.linesChanged === 1 ? 'line' : 'lines'})`,
            );
            logger.info(
              'chat',
              `Tool edit_file updated file (${exec.linesChanged} line(s) changed)`,
            );
            compactCallsForBudget.push({
              ...tc,
              function: {
                name: tc.function.name,
                arguments: JSON.stringify({
                  filename: requestedEditName || updatedArtifact.filename,
                  summary: '[edit payload omitted to fit context budget]',
                }),
              },
            });
          } else {
            const sig = `${tc.function.name}:${normalizeToolArgumentsJsonString(tc.function.arguments)}`;
            const repeatCount = (failedCallCounts.get(sig) ?? 0) + 1;
            failedCallCounts.set(sig, repeatCount);
            if (repeatCount >= 2) {
              forceFinalTextRound = true;
            }
            toolActivityLabels.push(`Failed edit_file: ${exec.error}`);
            logger.warn('chat', `Tool edit_file error: ${exec.error}`);
            compactCallsForBudget.push({
              ...tc,
              function: {
                name: tc.function.name,
                arguments: normalizeToolArgumentsJsonString(tc.function.arguments),
              },
            });
            const errorPayload =
              repeatCount >= 2
                ? JSON.stringify({
                    status: 'error',
                    error: `${exec.error} STOP repeating the exact same arguments—use read_attached_chunk first, fix your JSON parameters, or reply to the user directly.`,
                  })
                : exec.toolResultJson;
            inTurnToolTurns.push({
              id: `tool_res_${tc.id}`,
              role: 'tool',
              toolCallId: tc.id,
              name: tc.function.name,
              content: errorPayload,
            });
            continue;
          }
          inTurnToolTurns.push({
            id: `tool_res_${tc.id}`,
            role: 'tool',
            toolCallId: tc.id,
            name: tc.function.name,
            content: exec.toolResultJson,
          });
        } else if (tc.function.name === CALCULATE_TOOL_NAME) {
          const exec = executeCalculateTool(tc.function.arguments);
          if (exec.ok) {
            toolActivityLabels.push(`Calculated: ${safeTruncateChars(exec.formatted, 48)}`);
            logger.info('chat', `Tool calculate (${exec.mode}) succeeded`);
          } else {
            toolActivityLabels.push(`Failed calculate: ${exec.error}`);
            logger.warn('chat', `Tool calculate error: ${exec.error}`);
          }
          compactCallsForBudget.push({
            ...tc,
            function: {
              name: tc.function.name,
              arguments: normalizeToolArgumentsJsonString(tc.function.arguments),
            },
          });
          inTurnToolTurns.push({
            id: `tool_res_${tc.id}`,
            role: 'tool',
            toolCallId: tc.id,
            name: tc.function.name,
            content: exec.toolResultJson,
          });
        } else if (tc.function.name === READ_ATTACHED_CHUNK_TOOL_NAME) {
          const readableByLower = new Map<string, AttachedFileAttachment>();
          for (const att of sessionAttachedFiles) {
            readableByLower.set(att.name.toLowerCase(), att);
          }
          for (const msg of priorMessages) {
            for (const gen of msg.generatedFiles ?? []) {
              readableByLower.set(gen.filename.toLowerCase(), {
                name: gen.filename,
                content: gen.content,
              });
            }
          }
          for (const wf of turnWorkspaceFiles) {
            readableByLower.set(wf.filename.toLowerCase(), {
              name: wf.filename,
              content: wf.content,
            });
          }
          for (const gen of collectedFiles) {
            readableByLower.set(gen.filename.toLowerCase(), {
              name: gen.filename,
              content: gen.content,
            });
          }
          const exec = executeReadAttachedChunkTool(
            tc.function.arguments,
            Array.from(readableByLower.values()),
          );
          if (exec.ok) {
            toolActivityLabels.push(
              `Read ${exec.filename} L${exec.startLine}-${exec.endLine}`,
            );
            logger.info(
              'chat',
              `Tool read_attached_chunk read L${exec.startLine}-${exec.endLine}/${exec.totalLines}`,
            );
          } else {
            toolActivityLabels.push(`Failed read_attached_chunk: ${exec.error}`);
            logger.warn('chat', `Tool read_attached_chunk error: ${exec.error}`);
          }
          compactCallsForBudget.push(tc);
          inTurnToolTurns.push({
            id: `tool_res_${tc.id}`,
            role: 'tool',
            toolCallId: tc.id,
            name: tc.function.name,
            content: exec.toolResultJson,
          });
        } else if (tc.function.name === SEARCH_MEMORY_TOOL_NAME) {
          const exec = executeSearchMemoryTool(
            tc.function.arguments,
            sessionMemoryNotes,
            targetSessionId,
          );
          if (exec.ok) {
            toolActivityLabels.push(
              `Searched memory (${exec.count} ${exec.count === 1 ? 'hit' : 'hits'})`,
            );
            logger.info('memory', `Tool search_memory matched ${exec.count} note(s)`);
          } else {
            toolActivityLabels.push(`Failed search_memory: ${exec.error}`);
            logger.warn('memory', `Tool search_memory error: ${exec.error}`);
          }
          compactCallsForBudget.push(tc);
          inTurnToolTurns.push({
            id: `tool_res_${tc.id}`,
            role: 'tool',
            toolCallId: tc.id,
            name: tc.function.name,
            content: exec.toolResultJson,
          });
        } else if (tc.function.name === SAVE_MEMORY_TOOL_NAME) {
          const exec = executeSaveMemoryNoteTool(
            tc.function.arguments,
            createUuid,
            targetSession.title,
            targetSessionId,
          );
          if (exec.ok) {
            sessionMemoryNotes = [exec.note, ...sessionMemoryNotes];
            setWorkspace((prev) => ({
              ...prev,
              memoryNotes: [exec.note, ...prev.memoryNotes],
            }));
            toolActivityLabels.push(`Saved note: ${safeTruncateChars(exec.note.title, 40)}`);
            logger.info(
              'memory',
              `Tool save_memory_note created note ${exec.note.id} (pinned=${exec.note.isPinned})`,
            );
          } else {
            toolActivityLabels.push(`Failed save_memory_note: ${exec.error}`);
            logger.warn('memory', `Tool save_memory_note error: ${exec.error}`);
          }
          compactCallsForBudget.push(tc);
          inTurnToolTurns.push({
            id: `tool_res_${tc.id}`,
            role: 'tool',
            toolCallId: tc.id,
            name: tc.function.name,
            content: exec.toolResultJson,
          });
        } else if (tc.function.name === SAVE_WORKSPACE_FILE_TOOL_NAME) {
          if (!hasExplicitWorkspaceFileSaveIntent(rawInput)) {
            const blockedMsg =
              'save_workspace_file is only allowed when the user explicitly asks to save a file to the persistent Files tab. Use create_file or edit_file instead.';
            toolActivityLabels.push(`Skipped Files tab save: not requested by user`);
            logger.warn('files', `Blocked unrequested save_workspace_file call`);
            compactCallsForBudget.push(tc);
            inTurnToolTurns.push({
              id: `tool_res_${tc.id}`,
              role: 'tool',
              toolCallId: tc.id,
              name: tc.function.name,
              content: JSON.stringify({ status: 'error', error: blockedMsg }),
            });
            continue;
          }
          const sessionSources: AttachedFileAttachment[] = [
            ...sessionAttachedFiles,
            ...getSessionGeneratedFiles().map((gen) => ({
              name: gen.filename,
              content: gen.content,
            })),
          ];
          const liveWorkspaceFiles = workspaceRef.current.workspaceFiles;
          const exec = executeSaveWorkspaceFileTool(
            tc.function.arguments,
            liveWorkspaceFiles,
            sessionSources,
            createUuid,
            { allowAiFileEdits: workspaceRef.current.settings.allowAiFileEdits },
          );
          if (exec.ok) {
            turnWorkspaceFiles = exec.files;
            setWorkspace((prev) => ({
              ...prev,
              workspaceFiles: exec.files,
            }));
            setPreviewFile((curr) =>
              curr && curr.workspaceFileId === exec.file.id
                ? { ...curr, file: workspaceFileToArtifact(exec.file) }
                : curr,
            );
            baseAssemblyCandidates.coreInstruction = buildEffectiveCoreInstruction(
              workspaceRef.current.settings,
              selectedTools,
              turnWorkspaceFiles,
            );
            toolActivityLabels.push(
              `${exec.action === 'updated' ? 'Updated Files' : 'Saved to Files'}: ${exec.file.filename}`,
            );
            logger.info(
              'files',
              `Tool save_workspace_file ${exec.action} file ${exec.file.id} (${exec.file.sizeBytes} bytes)`,
            );
          } else {
            toolActivityLabels.push(`Failed save_workspace_file: ${exec.error}`);
            logger.warn('files', `Tool save_workspace_file error: ${exec.error}`);
          }
          const parsedSaveArgs = parseToolArgumentsJson(tc.function.arguments);
          compactCallsForBudget.push(
            exec.ok
              ? {
                  ...tc,
                  function: {
                    name: tc.function.name,
                    arguments: JSON.stringify({
                      filename:
                        typeof parsedSaveArgs?.filename === 'string'
                          ? parsedSaveArgs.filename
                          : exec.file.filename,
                      content: '[saved to Files tab]',
                    }),
                  },
                }
              : tc,
          );
          inTurnToolTurns.push({
            id: `tool_res_${tc.id}`,
            role: 'tool',
            toolCallId: tc.id,
            name: tc.function.name,
            content: exec.toolResultJson,
          });
        } else {
          const availableList = ALL_WORKSPACE_TOOLS.map((t) => t.function.name).join(', ');
          const errJson = JSON.stringify({
            status: 'error',
            error: `Unsupported tool '${tc.function.name}'. Available tools: ${availableList}.`,
          });
          compactCallsForBudget.push(tc);
          inTurnToolTurns.push({
            id: `tool_res_${tc.id}`,
            role: 'tool',
            toolCallId: tc.id,
            name: tc.function.name,
            content: errJson,
          });
        }
      }

      updateAssistantMessage((m) => ({
        ...m,
        generatedFiles: collectedFiles.length > 0 ? [...collectedFiles] : m.generatedFiles,
        toolActivity: toolActivityLabels.length > 0 ? [...toolActivityLabels] : m.toolActivity,
      }));

      const lastToolTurnStartIdx = inTurnToolTurns.findIndex(
        (t) => t.role === 'assistant' && t.toolCalls === normalizedRoundToolCalls,
      );
      const compactedTurns = inTurnToolTurns.map((t, idx) => {
        if (t.role === 'assistant' && t.toolCalls === normalizedRoundToolCalls) {
          return { ...t, toolCalls: compactCallsForBudget };
        }
        // Compact earlier large chunk-read outputs from prior rounds while keeping the latest round intact
        if (
          idx < lastToolTurnStartIdx &&
          t.role === 'tool' &&
          t.name === READ_ATTACHED_CHUNK_TOOL_NAME &&
          t.content.length > 400
        ) {
          return {
            ...t,
            content: JSON.stringify({
              status: 'ok',
              note: '[earlier chunk content omitted to fit context budget]',
            }),
          };
        }
        return t;
      });
      const nextAssembly = assembleWithCompaction(inTurnToolTurns, compactedTurns);

      if (!nextAssembly.ok) {
        stopDrip();
        setLiveTokensPerSecond(null);
        setBannerError(nextAssembly.message);
        updateAssistantMessage((m) => ({
          ...m,
          content: nextAssembly.message,
          isError: true,
        }));
        setGeneratingSessionId((curr) => (curr === targetSessionId ? null : curr));
        return;
      }

      currentInspection = nextAssembly.inspection;
      setLastTurnInspection(currentInspection);
      updateAssistantMessage((m) => ({
        ...m,
        turnBudget: buildTurnContextBudget(currentInspection),
      }));
    }
    },
    [logger],
  );

  const handleSendMessage = useCallback(async () => {
    const rawInput = composerText.trim();
    if ((!rawInput && !attachedFile) || !activeSession) {
      return;
    }
    if (generatingSessionId) {
      if (!queuedRequest) {
        setQueuedRequest({
          sessionId: activeSession.id,
          rawInput,
          attachedFile,
        });
        setComposerText('');
        setAttachedFile(null);
      }
      return;
    }
    await dispatchChatTurn({
      sessionId: activeSession.id,
      rawInput,
      attachedFile,
      clearComposer: true,
    });
  }, [composerText, attachedFile, activeSession, generatingSessionId, queuedRequest, dispatchChatTurn]);

  useEffect(() => {
    if (generatingSessionId !== null || !queuedRequest) return;
    if (pausedQueueOnStopRef.current) {
      return;
    }
    const next = queuedRequest;
    setQueuedRequest(null);
    void dispatchChatTurn({
      sessionId: next.sessionId,
      rawInput: next.rawInput,
      attachedFile: next.attachedFile,
      clearComposer: false,
    });
  }, [generatingSessionId, queuedRequest, dispatchChatTurn]);

  const handleCancelQueuedRequest = useCallback(() => {
    setQueuedRequest(null);
  }, []);

  const handleSendQueuedNow = useCallback(() => {
    if (!queuedRequest || generatingSessionId) return;
    const next = queuedRequest;
    setQueuedRequest(null);
    pausedQueueOnStopRef.current = false;
    void dispatchChatTurn({
      sessionId: next.sessionId,
      rawInput: next.rawInput,
      attachedFile: next.attachedFile,
      clearComposer: false,
    });
  }, [queuedRequest, generatingSessionId, dispatchChatTurn]);

  const handleRetryUserMessage = useCallback(
    async (messageId: string) => {
      if (!activeSession || generatingSessionId) return;
      const targetMsg = activeSession.messages.find(
        (m) => m.id === messageId && m.role === 'user',
      );
      if (!targetMsg) return;
      const cleanPrompt =
        targetMsg.attachedFiles && targetMsg.attachedFiles.length > 0
          ? targetMsg.content.replace(/\n\n\[Attached local file[\s\S]*$/, '').trim()
          : targetMsg.content.trim();
      const targetAttachment = targetMsg.attachedFiles?.[0] ?? null;
      if (!cleanPrompt && !targetAttachment) return;
      await dispatchChatTurn({
        sessionId: activeSession.id,
        rawInput: cleanPrompt,
        attachedFile: targetAttachment,
        truncateFromMessageId: messageId,
        clearComposer: false,
      });
    },
    [activeSession, generatingSessionId, dispatchChatTurn],
  );

  const handleContinueMessage = useCallback(
    async (messageId: string) => {
      if (!activeSession || generatingSessionId) return;
      await dispatchChatTurn({
        sessionId: activeSession.id,
        rawInput: '',
        attachedFile: null,
        continueAssistantMessageId: messageId,
        clearComposer: false,
      });
    },
    [activeSession, generatingSessionId, dispatchChatTurn],
  );

  const handleStopGeneration = useCallback(() => {
    pausedQueueOnStopRef.current = true;
    if (controllerRef.current?.getStatus().state === 'generating') {
      controllerRef.current.cancelGeneration();
    } else {
      activeDripCleanupRef.current?.();
    }
  }, []);

  const handleSaveReplyAsNote = useCallback(
    (content: string, messageId: string) => {
      const now = Date.now();
      const firstLine = content.split('\n')[0] || 'Saved assistant note';
      const newNote: MemoryNote = {
        id: `note_${createUuid().slice(0, 8)}`,
        sessionId: activeSession?.id,
        title: safeTruncateChars(firstLine, 48),
        content: safeTruncateChars(content, 400),
        sourceReference: `Session "${activeSession?.title ?? 'Chat'}"`,
        sourceMessageIds: [messageId],
        isPinned: false,
        isSummary: false,
        isDisabled: false,
        userApproved: true,
        createdAt: now,
        updatedAt: now,
      };
      setLastTurnInspection(null);
      setWorkspace((prev) => ({
        ...prev,
        memoryNotes: [newNote, ...prev.memoryNotes],
      }));
      logger.info('memory', `Saved chat reply as memory note ${newNote.id}`);
    },
    [activeSession, logger],
  );

  const handleUpdateTaskGoal = useCallback(
    (goal: string) => {
      if (!activeSession) return;
      const trimmed = goal.trim();
      setLastTurnInspection(null);
      setWorkspace((prev) => ({
        ...prev,
        sessions: prev.sessions.map((s) =>
          s.id === activeSession.id
            ? { ...s, taskGoal: trimmed || undefined, updatedAt: Date.now() }
            : s,
        ),
      }));
      logger.info(
        'chat',
        trimmed ? 'Updated active session task goal' : 'Cleared active session task goal',
      );
    },
    [activeSession, logger],
  );

  const handleGenerateSessionSummary = useCallback((): boolean => {
    if (!activeSession) return false;
    const draft = buildDraftSessionSummary(activeSession, `summary_${createUuid().slice(0, 8)}`);
    if (!draft) return false;
    setLastTurnInspection(null);
    setWorkspace((prev) => ({
      ...prev,
      memoryNotes: [draft, ...prev.memoryNotes],
    }));
    logger.info('memory', `Generated draft session summary ${draft.id} (awaiting approval)`);
    return true;
  }, [activeSession, logger]);

  const handleCreateNote = useCallback(
    (input: {
      title: string;
      content: string;
      sourceReference: string;
      isPinned: boolean;
      isSummary?: boolean;
    }) => {
      const now = Date.now();
      const isSummary = Boolean(input.isSummary);
      const note: MemoryNote = {
        id: `${isSummary ? 'summary' : 'note'}_${createUuid().slice(0, 8)}`,
        sessionId: isSummary ? activeSession?.id : undefined,
        title: input.title,
        content: input.content,
        sourceReference: input.sourceReference,
        sourceMessageIds: [],
        isPinned: input.isPinned,
        isSummary,
        isDisabled: false,
        userApproved: !isSummary,
        createdAt: now,
        updatedAt: now,
      };
      setLastTurnInspection(null);
      setWorkspace((prev) => ({
        ...prev,
        memoryNotes: [note, ...prev.memoryNotes],
      }));
      logger.info(
        'memory',
        `Created ${isSummary ? 'draft summary' : 'memory note'} ${note.id} (pinned=${note.isPinned})`,
      );
    },
    [activeSession?.id, logger],
  );

  const handleUpdateNote = useCallback(
    (
      noteId: string,
      patch: Partial<
        Pick<
          MemoryNote,
          'title' | 'content' | 'sourceReference' | 'isPinned' | 'isDisabled' | 'userApproved'
        >
      >,
    ) => {
      setLastTurnInspection(null);
      setWorkspace((prev) => ({
        ...prev,
        memoryNotes: prev.memoryNotes.map((n) =>
          n.id === noteId ? { ...n, ...patch, updatedAt: Date.now() } : n,
        ),
      }));
      logger.info('memory', `Updated memory note ${noteId}`);
    },
    [logger],
  );

  const handleDeleteNote = useCallback(
    (noteId: string) => {
      setLastTurnInspection(null);
      setWorkspace((prev) => ({
        ...prev,
        memoryNotes: prev.memoryNotes.filter((n) => n.id !== noteId),
      }));
      logger.info('memory', `Deleted memory note ${noteId}`);
    },
    [logger],
  );

  const workspaceFilenames = useMemo(
    () => new Set(workspace.workspaceFiles.map((f) => f.filename.toLowerCase())),
    [workspace.workspaceFiles],
  );

  const handleUploadWorkspaceFiles = useCallback(
    (items: Array<{ filename: string; content: string }>) => {
      setBannerError(null);
      setLastTurnInspection(null);
      let nextFiles = workspaceRef.current.workspaceFiles;
      const errors: string[] = [];
      let addedCount = 0;

      for (const item of items) {
        const res = upsertWorkspaceFile(
          nextFiles,
          {
            filename: item.filename,
            content: item.content,
            source: 'upload',
          },
          createUuid,
        );
        if (res.ok) {
          nextFiles = res.files;
          addedCount += 1;
        } else {
          errors.push(res.error);
        }
      }

      if (addedCount > 0) {
        setWorkspace((prev) => ({
          ...prev,
          workspaceFiles: nextFiles,
        }));
        logger.info('files', `Uploaded ${addedCount} file(s) to persistent Files tab`);
      }
      if (errors.length > 0) {
        setBannerError(errors.join(' '));
      }
    },
    [logger],
  );

  const handleSaveArtifactToWorkspaceFiles = useCallback(
    (artifact: GeneratedFileArtifact) => {
      setBannerError(null);
      setLastTurnInspection(null);
      const res = upsertWorkspaceFile(
        workspaceRef.current.workspaceFiles,
        {
          filename: artifact.filename,
          content: artifact.content,
          title: artifact.title,
          language: artifact.language,
          source: 'chat',
        },
        createUuid,
      );
      if (!res.ok) {
        setBannerError(res.error);
        return;
      }
      setWorkspace((prev) => ({
        ...prev,
        workspaceFiles: res.files,
      }));
      logger.info('files', `Saved file ${res.file.id} from chat to persistent Files tab`);
    },
    [logger],
  );

  const handleToggleWorkspaceFileLock = useCallback(
    (fileId: string, locked: boolean) => {
      setLastTurnInspection(null);
      setWorkspace((prev) => ({
        ...prev,
        workspaceFiles: prev.workspaceFiles.map((f) =>
          f.id === fileId ? { ...f, lockedByUser: locked } : f,
        ),
      }));
      logger.info('files', `Set LLM edit lock=${locked} on file ${fileId}`);
    },
    [logger],
  );

  const handleDeleteWorkspaceFile = useCallback(
    (fileId: string) => {
      setLastTurnInspection(null);
      setPreviewFile((curr) => (curr?.workspaceFileId === fileId ? null : curr));
      setWorkspace((prev) => ({
        ...prev,
        workspaceFiles: prev.workspaceFiles.filter((f) => f.id !== fileId),
      }));
      logger.info('files', `Deleted file ${fileId} from persistent Files tab`);
    },
    [logger],
  );

  const handleTestLmStudioConnection = useCallback(async () => {
    setIsTestingConnection(true);
    setBannerError(null);
    const res = await fetchLocalLmStudioModels(workspace.settings.lmStudioEndpoint, logger);
    setIsTestingConnection(false);

    if (!res.ok) {
      setWorkspace((prev) => ({
        ...prev,
        settings: {
          ...prev.settings,
          connectionStatus: `Error: ${res.error}`,
        },
      }));
      return;
    }

    const firstModel = res.models[0] ?? '';
    setWorkspace((prev) => {
      const currentSelected = prev.settings.selectedLmModel;
      const nextSelectedModel =
        res.models.length > 0
          ? res.models.includes(currentSelected)
            ? currentSelected
            : firstModel
          : '';

      return {
        ...prev,
        models: prev.models.map((m) =>
          m.backendType === 'lm_studio' ? { ...m, filePath: res.endpoint } : m,
        ),
        settings: {
          ...prev.settings,
          lmStudioEndpoint: res.endpoint,
          connectedLmModels: res.models,
          selectedLmModel: nextSelectedModel,
          connectionStatus:
            res.models.length > 0
              ? `Connected (${res.models.length} model${res.models.length === 1 ? '' : 's'} available)`
              : 'Connected, but no models are currently loaded in LM Studio.',
        },
      };
    });
  }, [workspace.settings.lmStudioEndpoint, logger]);

  const handleSelectLmModel = useCallback(
    (modelName: string) => {
      manuallyUnloadedRef.current = false;
      setBannerError(null);
      setLastTurnInspection(null);
      const currentWorkspace = workspaceRef.current;
      const prevSettings = currentWorkspace.settings;
      if (prevSettings.selectedLmModel && prevSettings.selectedLmModel !== modelName) {
        triggerLmStudioUnloadAll(prevSettings);
      }
      if (controllerRef.current?.isLoaded()) {
        controllerRef.current.unloadModel();
      }
      const lmProfile = currentWorkspace.models.find((m) => m.backendType === 'lm_studio');
      setWorkspace((prev) => {
        const nextLmProfile = prev.models.find((m) => m.backendType === 'lm_studio');
        const nextActiveModelId = nextLmProfile ? nextLmProfile.id : prev.activeModelId;
        return {
          ...prev,
          activeModelId: nextActiveModelId,
          settings: {
            ...prev.settings,
            activeBackendType: nextLmProfile ? 'lm_studio' : prev.settings.activeBackendType,
            selectedLmModel: modelName,
          },
        };
      });
      if (lmProfile && controllerRef.current) {
        const effectiveCtx = getEffectiveContextLimit(
          lmProfile,
          prevSettings.contextLimitOverride,
        );
        const loadRes = controllerRef.current.loadModel({
          ...lmProfile,
          contextOverride: effectiveCtx,
        });
        if (!loadRes.ok) {
          setBannerError(loadRes.error);
        }
      }
      logger.info('settings', 'Selected LM Studio server model (previous model unloaded)');
    },
    [logger, triggerLmStudioUnloadAll],
  );

  const handleLockVault = useCallback(
    async (passphrase: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      controllerRef.current?.cancelGeneration();
      controllerRef.current?.unloadModel();
      const res = await sealWorkspaceVault(workspaceRef.current, passphrase, logger);
      if (res.ok) {
        setVaultModeActive(true);
        setPreviewFile(null);
        setLastTurnInspection(null);
        setWorkspace(createDefaultWorkspace());
        setVaultLocked(true);
      }
      return res;
    },
    [logger],
  );

  const handleUnlockVault = useCallback(
    async (passphrase: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const res = await unsealWorkspaceVault(passphrase, logger);
      if (!res.ok) {
        return res;
      }
      setWorkspace(res.workspace);
      setVaultModeActive(true);
      setLastTurnInspection(null);
      setVaultLocked(false);
      return { ok: true };
    },
    [logger],
  );

  const handleLockActiveVaultNow = useCallback(async () => {
    controllerRef.current?.cancelGeneration();
    controllerRef.current?.unloadModel();
    const res = await lockActiveVaultNow(workspaceRef.current, logger);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setPreviewFile(null);
    setLastTurnInspection(null);
    setWorkspace(createDefaultWorkspace());
    setVaultLocked(true);
  }, [logger]);

  const handleDisableVaultEncryption = useCallback(() => {
    const res = disableVaultEncryption(workspaceRef.current, logger);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setWorkspace(res.workspace);
    setVaultModeActive(false);
  }, [logger]);

  const handleResetVault = useCallback(() => {
    controllerRef.current?.cancelGeneration();
    controllerRef.current?.unloadModel();
    const fresh = resetAndWipeVault(logger);
    setWorkspace(fresh);
    setVaultModeActive(false);
    setPreviewFile(null);
    setLastTurnInspection(null);
    setBannerError(null);
    setVaultLocked(false);
  }, [logger]);

  if (vaultLocked) {
    return <VaultLockOverlay onUnlock={handleUnlockVault} onResetVault={handleResetVault} />;
  }

  const backendLabel =
    activeModel?.backendType === 'lm_studio' ? 'LM Studio (Loopback)' : 'Offline Mock';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--lc-bg)] text-[var(--lc-ink)]">
      {/* Left Navigation Sidebar */}
      {sidebarLayout.leftOpen && (
        <SidebarNav
          currentTab={currentTab}
          onSelectTab={setCurrentTab}
          sessions={workspace.sessions}
          activeSessionId={workspace.activeSessionId}
          generatingSessionId={generatingSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
          username={workspace.settings.userProfile?.username}
          totalLifetimeTokens={workspace.tokenUsage?.totalLifetimeTokens ?? 0}
          width={sidebarLayout.leftWidth}
          onResizeWidth={handleResizeLeftSidebar}
        />
      )}

      {/* Main Content Area + Dismissible System Banner */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {bannerError && (
          <div
            role="alert"
            data-testid="system-error-banner"
            className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--lc-danger)]/35 bg-[var(--lc-danger)]/10 px-6 py-2.5 text-[13px] text-[var(--lc-danger)]"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--lc-danger)]" />
              <span>{bannerError}</span>
            </div>
            <button
              type="button"
              onClick={() => setBannerError(null)}
              aria-label="Dismiss error banner"
              className="rounded p-0.5 text-[var(--lc-danger)] hover:bg-[var(--lc-danger)]/15"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {currentTab === 'chat' && activeSession && (
            <>
              <ChatView
                session={activeSession}
                models={workspace.models}
                activeModelId={workspace.activeModelId}
                onSelectActiveModel={handleSelectActiveModel}
                connectedLmModels={workspace.settings.connectedLmModels}
                selectedLmModel={workspace.settings.selectedLmModel}
                modelDisplayAliases={workspace.settings.modelDisplayAliases}
                modelIconOverrides={workspace.settings.modelIconOverrides}
                onSelectLmModel={handleSelectLmModel}
                effortLevel={workspace.settings.effortLevel}
                chatWidth={workspace.settings.chatWidth ?? 'default'}
                onChangeEffortLevel={(level) => {
                  setLastTurnInspection(null);
                  setWorkspace((prev) => ({
                    ...prev,
                    settings: { ...prev.settings, effortLevel: level },
                  }));
                }}
                backendLabel={backendLabel}
                workerStatus={workerStatus}
                leftSidebarOpen={sidebarLayout.leftOpen}
                onToggleLeftSidebar={handleToggleLeftSidebar}
                rightSidebarOpen={sidebarLayout.rightOpen}
                onToggleRightSidebar={handleToggleRightSidebar}
                composerText={composerText}
                onComposerTextChange={setComposerText}
                attachedFile={attachedFile}
                onAttachFile={setAttachedFile}
                memoryRetrievalEnabled={workspace.settings.memoryRetrievalEnabled}
                onToggleMemoryRetrieval={(enabled) => {
                  setLastTurnInspection(null);
                  setWorkspace((prev) => ({
                    ...prev,
                    settings: { ...prev.settings, memoryRetrievalEnabled: enabled },
                  }));
                }}
                isGenerating={generatingSessionId === activeSession.id}
                liveTokensPerSecond={
                  generatingSessionId === activeSession.id ? liveTokensPerSecond : null
                }
                hoveredSegment={hoveredSegment}
                onHoverSegment={setHoveredSegment}
                onSendMessage={() => void handleSendMessage()}
                onStopGeneration={handleStopGeneration}
                onNewSession={handleNewSession}
                onSummarizeSession={handleGenerateSessionSummary}
                onReviewSummaries={() => {
                  setRequestedMemoryFilter((prev) => ({
                    filter: 'summaries',
                    seq: (prev?.seq ?? 0) + 1,
                  }));
                  setCurrentTab('memory');
                }}
                onOpenSources={setActiveSources}
                onSaveAsNote={handleSaveReplyAsNote}
                activePreviewFileId={
                  previewFile && previewFile.sessionId === activeSession.id
                    ? previewFile.file.id
                    : null
                }
                onOpenFilePreview={(file) => {
                  setPreviewFile((curr) =>
                    curr && curr.file.id === file.id && curr.sessionId === activeSession.id
                      ? null
                      : { file, sessionId: activeSession.id },
                  );
                }}
                workspaceFilenames={workspaceFilenames}
                onSaveArtifactToWorkspaceFiles={handleSaveArtifactToWorkspaceFiles}
                onRetryUserMessage={(msgId) => void handleRetryUserMessage(msgId)}
                onContinueMessage={(msgId) => void handleContinueMessage(msgId)}
                queuedRequest={
                  queuedRequest && queuedRequest.sessionId === activeSession.id
                    ? queuedRequest
                    : null
                }
                hasQueuedRequestAnywhere={Boolean(queuedRequest)}
                onCancelQueuedRequest={handleCancelQueuedRequest}
                onSendQueuedNow={handleSendQueuedNow}
              />

              {previewFile &&
              (previewFile.sessionId === activeSession.id || previewFile.workspaceFileId) ? (
                (() => {
                  const matchedWorkspaceFile = previewFile.workspaceFileId
                    ? workspace.workspaceFiles.find((wf) => wf.id === previewFile.workspaceFileId)
                    : undefined;
                  const displayedPreviewFile = matchedWorkspaceFile
                    ? workspaceFileToArtifact(matchedWorkspaceFile)
                    : previewFile.file;
                  return (
                    <FilePreviewPanel
                      file={displayedPreviewFile}
                      onClose={() => setPreviewFile(null)}
                      isInWorkspaceFiles={
                        Boolean(matchedWorkspaceFile) ||
                        workspaceFilenames.has(displayedPreviewFile.filename.toLowerCase())
                      }
                      isLockedInWorkspace={matchedWorkspaceFile?.lockedByUser ?? false}
                      onToggleWorkspaceLock={
                        matchedWorkspaceFile
                          ? () =>
                              handleToggleWorkspaceFileLock(
                                matchedWorkspaceFile.id,
                                !matchedWorkspaceFile.lockedByUser,
                              )
                          : undefined
                      }
                      onSaveToWorkspaceFiles={
                        !matchedWorkspaceFile
                          ? () => handleSaveArtifactToWorkspaceFiles(displayedPreviewFile)
                          : undefined
                      }
                    />
                  );
                })()
              ) : sidebarLayout.rightOpen ? (
                <RightSidebarPanel
                  activeTab={rightSidebarTab}
                  onSelectTab={setRightSidebarTab}
                  budget={activeTurnBudget}
                  previewWarning={previewWarning}
                  taskGoal={activeSession.taskGoal}
                  onUpdateTaskGoal={handleUpdateTaskGoal}
                  memoryNotes={workspace.memoryNotes}
                  includedMemoryIds={activeInspection.includedMemoryIds}
                  memoryRetrievalEnabled={workspace.settings.memoryRetrievalEnabled}
                  onToggleMemoryRetrieval={(enabled) => {
                    setLastTurnInspection(null);
                    setWorkspace((prev) => ({
                      ...prev,
                      settings: { ...prev.settings, memoryRetrievalEnabled: enabled },
                    }));
                  }}
                  hoveredSegment={hoveredSegment}
                  onHoverSegment={setHoveredSegment}
                  onOpenPromptInspector={() => setShowPromptInspector(true)}
                  workspaceFiles={workspace.workspaceFiles}
                  allowAiFileEdits={workspace.settings.allowAiFileEdits}
                  onUploadWorkspaceFiles={handleUploadWorkspaceFiles}
                  onToggleWorkspaceFileLock={handleToggleWorkspaceFileLock}
                  onDeleteWorkspaceFile={handleDeleteWorkspaceFile}
                  onPreviewWorkspaceFile={(wf) =>
                    setPreviewFile({
                      file: workspaceFileToArtifact(wf),
                      sessionId: activeSession.id,
                      workspaceFileId: wf.id,
                    })
                  }
                  onOpenFileSettings={() => setCurrentTab('settings')}
                  width={sidebarLayout.rightWidth}
                  onResizeWidth={handleResizeRightSidebar}
                />
              ) : null}
            </>
          )}

          {currentTab === 'models' && (
            <ModelsView
              models={workspace.models}
              activeModelId={workspace.activeModelId}
              workerStatus={workerStatus}
              globalContextOverride={workspace.settings.contextLimitOverride}
              lmStudioEndpoint={workspace.settings.lmStudioEndpoint}
              leftSidebarOpen={sidebarLayout.leftOpen}
              onToggleLeftSidebar={handleToggleLeftSidebar}
              onSelectActiveModel={handleSelectActiveModel}
              onLoadModel={handleLoadModel}
              onUnloadModel={handleUnloadModel}
              onAddModel={(profile) => {
                setWorkspace((prev) => ({
                  ...prev,
                  models: [...prev.models, profile],
                }));
                logger.info('models', `Added model profile ${profile.id}`);
              }}
              onUpdateModel={(modelId, patch) => {
                setLastTurnInspection(null);
                setWorkspace((prev) => ({
                  ...prev,
                  models: prev.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)),
                }));
              }}
              onRemoveModel={(modelId) => {
                setWorkspace((prev) => {
                  const remaining = prev.models.filter((m) => m.id !== modelId);
                  if (remaining.length === 0) return prev;
                  const nextActive =
                    prev.activeModelId === modelId ? remaining[0].id : prev.activeModelId;
                  return { ...prev, models: remaining, activeModelId: nextActive };
                });
                logger.info('models', `Removed model profile ${modelId}`);
              }}
            />
          )}

          {currentTab === 'memory' && (
            <MemoryView
              notes={workspace.memoryNotes}
              includedMemoryIds={activeInspection.includedMemoryIds}
              activeSessionId={workspace.activeSessionId}
              canSummarizeActiveSession={Boolean(
                activeSession?.messages.some(
                  (m) =>
                    (m.role === 'user' || m.role === 'assistant') &&
                    !m.isError &&
                    m.content.trim().length > 0,
                ),
              )}
              requestedFilter={requestedMemoryFilter}
              leftSidebarOpen={sidebarLayout.leftOpen}
              onToggleLeftSidebar={handleToggleLeftSidebar}
              onGenerateSessionSummary={() => {
                handleGenerateSessionSummary();
              }}
              onCreateNote={handleCreateNote}
              onUpdateNote={handleUpdateNote}
              onDeleteNote={handleDeleteNote}
            />
          )}

          {currentTab === 'settings' && (
            <SettingsView
              settings={workspace.settings}
              activeModel={activeModel}
              diagnosticEntries={diagnosticEntries}
              isTestingConnection={isTestingConnection}
              leftSidebarOpen={sidebarLayout.leftOpen}
              onToggleLeftSidebar={handleToggleLeftSidebar}
              onUpdateSettings={(patch) => {
                setLastTurnInspection(null);
                setWorkspace((prev) => ({
                  ...prev,
                  settings: { ...prev.settings, ...patch },
                }));
              }}
              onSwitchBackend={handleSwitchBackend}
              onTestLmStudioConnection={handleTestLmStudioConnection}
              onSelectLmModel={handleSelectLmModel}
              vaultModeActive={vaultModeActive}
              onLockVault={handleLockVault}
              onLockActiveVaultNow={() => void handleLockActiveVaultNow()}
              onDisableVaultEncryption={handleDisableVaultEncryption}
              onClearDiagnostics={() => logger.clear()}
            />
          )}

          {currentTab === 'profile' && (
            <ProfileView
              profile={
                workspace.settings.userProfile ?? {
                  username: '',
                  customSystemPrompt: '',
                }
              }
              tokenUsage={workspace.tokenUsage ?? createEmptyTokenUsage()}
              leftSidebarOpen={sidebarLayout.leftOpen}
              onToggleLeftSidebar={handleToggleLeftSidebar}
              onUpdateProfile={(patch) => {
                setLastTurnInspection(null);
                setWorkspace((prev) => ({
                  ...prev,
                  settings: {
                    ...prev.settings,
                    userProfile: {
                      username: prev.settings.userProfile?.username ?? '',
                      customSystemPrompt: prev.settings.userProfile?.customSystemPrompt ?? '',
                      ...patch,
                    },
                  },
                }));
              }}
            />
          )}
        </main>
      </div>

      {/* Modals */}
      <PromptInspectorModal
        isOpen={showPromptInspector}
        inspection={activeInspection}
        onClose={() => setShowPromptInspector(false)}
      />

      <SourcesModal sources={activeSources} onClose={() => setActiveSources(null)} />
    </div>
  );
};

export default App;
