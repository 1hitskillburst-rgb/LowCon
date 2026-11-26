import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { ChatView } from './components/chat/ChatView';
import { ContextPanel } from './components/chat/ContextPanel';
import { FilePreviewPanel } from './components/chat/FilePreviewPanel';
import { SidebarNav } from './components/layout/SidebarNav';
import { PromptInspectorModal } from './components/modals/PromptInspectorModal';
import { SourcesModal } from './components/modals/SourcesModal';
import { VaultLockOverlay } from './components/modals/VaultLockOverlay';
import { MemoryView, type MemoryFilter } from './components/views/MemoryView';
import { ModelsView } from './components/views/ModelsView';
import { SettingsView } from './components/views/SettingsView';
import {
  assembleContext,
  buildTurnContextBudget,
  stopSequencesForTemplate,
  type AssemblyCandidates,
  type ConversationTurnCandidate,
} from './core/context';
import {
  fetchLocalLmStudioModels,
  InferenceController,
  type StreamStopReason,
} from './core/inference';
import {
  buildDraftSessionSummary,
  buildSummaryCandidates,
  getPinnedNotesForPrompt,
  retrieveMemoryNotes,
} from './core/memory';
import { DiagnosticLogger, safeTruncateChars } from './core/privacy';
import {
  createDefaultWorkspace,
  createUuid,
  isVaultSealed,
  loadUnsealedWorkspace,
  saveUnsealedWorkspace,
  sealWorkspaceVault,
  unsealWorkspaceVault,
} from './core/storage';
import { applyThemeToDocument } from './core/theme';
import {
  countLines,
  CREATE_FILE_TOOL_DEFINITION,
  CREATE_FILE_TOOL_NAME,
  executeCreateFileTool,
  TOOL_CALL_POLICY_INSTRUCTION,
} from './core/tools';
import {
  getEffectiveContextLimit,
  type AppSettings,
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
  type WorkerStatus,
} from './core/types';

const MAX_TOOL_ROUNDS = 4;

const CORE_SYSTEM_INSTRUCTION =
  'You are LowCon, a private, deterministic assistant running on this device. Respect all pinned project rules, cite local memory when relevant, and keep responses accurate and concise.';

function buildEffectiveCoreInstruction(settings: AppSettings): string {
  const base = `${CORE_SYSTEM_INSTRUCTION}\n\n${TOOL_CALL_POLICY_INSTRUCTION}`;
  if (!settings.promptEffortEnabled) {
    return base;
  }
  const effortPrompt = settings.promptEffortPrompts?.[settings.effortLevel]?.trim();
  if (!effortPrompt) {
    return base;
  }
  return `${base}\n\n[Reasoning Effort: ${settings.effortLevel.toUpperCase()}]\n${effortPrompt}`;
}

function mapSessionHistoryTurns(messages: ChatMessage[]): ConversationTurnCandidate[] {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.isError && m.content.trim())
    .map((m) => {
      let content = m.content;
      if (m.role === 'assistant' && m.generatedFiles && m.generatedFiles.length > 0) {
        const fileSummary = m.generatedFiles
          .map((f) => `${f.filename} (${f.language}, ${countLines(f.content)} lines)`)
          .join(', ');
        content = `${content}\n\n[Attached generated files: ${fileSummary}]`;
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
  const previewUserMsg = attachedFile
    ? rawDraft
      ? `${rawDraft}\n\n[Attached local file: ${attachedFile.name}]\n${attachedFile.content}`
      : `[Attached local file: ${attachedFile.name}]\n${attachedFile.content}`
    : rawDraft;

  const candidates: AssemblyCandidates = {
    coreInstruction: buildEffectiveCoreInstruction(settings),
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
    tools: [CREATE_FILE_TOOL_DEFINITION],
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
      outputReservePct: settings.outputReservePct,
      safetyMarginPct: settings.safetyMarginPct,
      templateType,
      allowEmptyUserMessage: true,
    },
  );
  if (fallback.ok) {
    return { inspection: fallback.inspection, previewWarning: result.message };
  }
  throw new Error(fallback.message);
}

export const App: React.FC = () => {
  const loggerRef = useRef<DiagnosticLogger | null>(null);
  if (!loggerRef.current) {
    loggerRef.current = new DiagnosticLogger('minimal_redacted');
  }
  const logger = loggerRef.current;

  const [vaultLocked, setVaultLocked] = useState<boolean>(() => isVaultSealed());
  const [bannerError, setBannerError] = useState<string | null>(null);

  const [workspace, setWorkspace] = useState<PersistedWorkspace>(() => {
    if (isVaultSealed()) {
      return createDefaultWorkspace();
    }
    const loaded = loadUnsealedWorkspace(logger);
    if (loaded.storageWarning) {
      setTimeout(() => setBannerError(loaded.storageWarning ?? null), 0);
    }
    return loaded.workspace;
  });

  const [currentTab, setCurrentTab] = useState<NavigationTab>('chat');
  const [composerText, setComposerText] = useState('');
  const [attachedFile, setAttachedFile] = useState<{ name: string; content: string } | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<ContextSegmentKey | null>(null);
  const [showPromptInspector, setShowPromptInspector] = useState(false);
  const [activeSources, setActiveSources] = useState<string[] | null>(null);
  const [previewFile, setPreviewFile] = useState<{
    file: GeneratedFileArtifact;
    sessionId: string;
  } | null>(null);
  const [lastTurnInspection, setLastTurnInspection] = useState<PromptInspection | null>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>({ state: 'unloaded' });
  const [generatingSessionId, setGeneratingSessionId] = useState<string | null>(null);
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
  const activeDripCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      activeDripCleanupRef.current?.();
    };
  }, []);

  // Subscribe to diagnostic logger updates and apply active theme variables
  useEffect(() => {
    applyThemeToDocument(workspace.settings.theme);
  }, [workspace.settings.theme]);

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

  // Persist unsealed workspace reliably on every state change
  useEffect(() => {
    if (vaultLocked) return;
    const res = saveUnsealedWorkspace(workspace, logger);
    if (!res.ok) {
      setBannerError(res.error);
    }
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
    workspace.settings,
  ]);

  const activeTurnBudget = useMemo(
    () => buildTurnContextBudget(activeInspection),
    [activeInspection],
  );

  const handleSelectActiveModel = useCallback(
    (modelId: string) => {
      manuallyUnloadedRef.current = false;
      setBannerError(null);
      setLastTurnInspection(null);
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
    [],
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
  }, []);

  const handleSwitchBackend = useCallback((backend: BackendType) => {
    manuallyUnloadedRef.current = false;
    setBannerError(null);
    setLastTurnInspection(null);
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
  }, []);

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

  const handleSendMessage = useCallback(async () => {
    const rawInput = composerText.trim();
    if (!rawInput || !activeSession || !activeModel || !controllerRef.current) return;
    if (generatingSessionId) return;

    setBannerError(null);

    const userContent = attachedFile
      ? `${rawInput}\n\n[Attached local file: ${attachedFile.name}]\n${attachedFile.content}`
      : rawInput;

    const targetSessionId = activeSession.id;
    const effectiveLimit = getEffectiveContextLimit(
      activeModel,
      workspace.settings.contextLimitOverride,
    );

    // 1. Ensure model is loaded into worker before assembling/sending
    if (!controllerRef.current.isLoaded()) {
      manuallyUnloadedRef.current = false;
      const loadRes = controllerRef.current.loadModel({
        ...activeModel,
        contextOverride: effectiveLimit,
      });
      if (!loadRes.ok) {
        setBannerError(loadRes.error);
        return;
      }
    }

    // 2. Fetch pinned project rules UNCONDITIONALLY (fixes keyword-gated pin bug)
    const nonSummaryNotes = workspace.memoryNotes.filter((n) => !n.isSummary);
    const pinnedNotes = getPinnedNotesForPrompt(nonSummaryNotes, targetSessionId);

    // 3. Fetch unpinned relevant memories via BM25 FTS across ALL notes
    const retrievedScored = workspace.settings.memoryRetrievalEnabled
      ? retrieveMemoryNotes(nonSummaryNotes, {
          query: userContent,
          sessionId: targetSessionId,
          excludePinned: true,
          requireApproved: true,
          limit: 8,
        })
      : [];

    const summaryCandidates = buildSummaryCandidates(workspace.memoryNotes, targetSessionId);
    const historyTurns = mapSessionHistoryTurns(activeSession.messages);

    const baseAssemblyCandidates = {
      coreInstruction: buildEffectiveCoreInstruction(workspace.settings),
      pinnedFacts: pinnedNotes.map((n) => ({
        id: n.id,
        title: n.title,
        content: n.content,
        sourceReference: n.sourceReference,
      })),
      taskState: activeSession.taskGoal ? { goal: activeSession.taskGoal } : undefined,
      retrievedMemories: retrievedScored.map((s) => ({
        id: s.note.id,
        title: s.note.title,
        excerpt: s.note.content,
        sourceMessageId: s.note.sourceMessageIds[0],
        relevanceScore: s.finalScore,
        isPinned: false,
      })),
      summaries: summaryCandidates,
      tools: [CREATE_FILE_TOOL_DEFINITION],
    };

    // 4. Deterministic budget-first context assembly with user's exact reserve % & model template
    const assemblyResult = assembleContext(
      {
        ...baseAssemblyCandidates,
        currentUserMessage: userContent,
        conversationTurns: historyTurns,
      },
      {
        modelContextLimit: effectiveLimit,
        outputReservePct: workspace.settings.outputReservePct,
        safetyMarginPct: workspace.settings.safetyMarginPct,
        templateType: activeModel.chatTemplate,
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
    const assistantMsgId = createUuid();
    const modelDisplayLabel =
      activeModel.backendType === 'lm_studio' && workspace.settings.selectedLmModel
        ? `${workspace.settings.selectedLmModel} · ${activeModel.chatTemplate}`
        : `${activeModel.name} · ${activeModel.chatTemplate}`;

    const userMessage: ChatMessage = {
      id: userMsgId,
      role: 'user',
      authorName: 'You',
      createdAt: now,
      content: userContent,
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

    // Append messages & auto-title new sessions
    setWorkspace((prev) => ({
      ...prev,
      sessions: prev.sessions.map((s) => {
        if (s.id !== targetSessionId) return s;
        const shouldRename =
          s.messages.length === 0 &&
          (s.title === 'New local session' || s.title === 'Context strategy / 8K model');
        return {
          ...s,
          title: shouldRename ? safeTruncateChars(rawInput, 36) : s.title,
          updatedAt: now,
          messages: [...s.messages, userMessage, assistantPlaceholder],
        };
      }),
    }));

    // Progressive word-by-word drip queue for visible answer text
    activeDripCleanupRef.current?.();

    setComposerText('');
    setAttachedFile(null);
    setGeneratingSessionId(targetSessionId);
    setLiveTokensPerSecond(null);

    logger.info(
      'chat',
      `Dispatching turn (session=${targetSessionId.slice(0, 8)}, packed=${inspection.totalTokens}/${inspection.budgetPartition.promptBudget}, max_tokens=${inspection.budgetPartition.outputReserve}, pinned=${pinnedNotes.length}, retrieved=${retrievedScored.length})`,
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
    const collectedFiles: GeneratedFileArtifact[] = [];
    const toolActivityLabels: string[] = [];

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
      updateAssistantMessage((m) => ({
        ...m,
        tokenCount: completion.totalTokens,
        tokensPerSecond:
          completion.tokensPerSecond > 0 ? completion.tokensPerSecond : m.tokensPerSecond,
        stopReason: completion.stopReason,
        thinkingDurationMs: thinkingDurationMs ?? m.thinkingDurationMs,
        ...(collectedFiles.length > 0 ? { generatedFiles: [...collectedFiles] } : {}),
        ...(toolActivityLabels.length > 0 ? { toolActivity: [...toolActivityLabels] } : {}),
      }));
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
        }
      | { status: 'cancelled' }
      | { status: 'error'; message: string };

    const runStep = (stepInspection: PromptInspection): Promise<StepOutcome> =>
      new Promise((resolve) => {
        let stepRawText = '';
        void controllerRef.current!.startGeneration(
          targetSessionId,
          {
            exactRenderedPrompt: stepInspection.exactRenderedPrompt,
            structuredMessages: stepInspection.structuredMessages,
            maxTokens: stepInspection.budgetPartition.outputReserve,
            temperature: 0.7,
            topP: 0.9,
            stopSequences: stopSequencesForTemplate(activeModel.chatTemplate),
            lmStudioEndpoint: workspace.settings.lmStudioEndpoint,
            selectedLmModel: workspace.settings.selectedLmModel,
            reasoningEffort: workspace.settings.promptEffortEnabled
              ? undefined
              : workspace.settings.effortLevel,
            tools: stepInspection.tools,
            toolChoice: stepInspection.tools?.length ? 'auto' : undefined,
          },
          {
            onThinkingToken: (token) => {
              if (dripStopped) return;
              if (thinkingStartedAt === null) {
                thinkingStartedAt = performance.now();
              }
              updateAssistantMessage((m) => ({
                ...m,
                thinkingContent: (m.thinkingContent ?? '') + token,
              }));
            },
            onToolCallDetected: (toolName) => {
              if (dripStopped) return;
              const label =
                toolName === CREATE_FILE_TOOL_NAME ? 'Writing file...' : `Running ${toolName}...`;
              updateAssistantMessage((m) => ({
                ...m,
                toolActivity: [...toolActivityLabels, label],
              }));
            },
            onToken: (token) => {
              if (dripStopped) return;
              if (thinkingStartedAt !== null && thinkingFinishedAt === null && token.trim()) {
                thinkingFinishedAt = performance.now();
              }
              stepRawText += token;
              pendingWordQueue += token;
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
              resolve({
                status: 'complete',
                totalTokens,
                stopReason,
                tokensPerSecond: stats?.tokensPerSecond ?? 0,
                toolCalls: stats?.toolCalls,
                rawText: stepRawText,
              });
            },
            onCancelled: () => resolve({ status: 'cancelled' }),
            onError: (message) => resolve({ status: 'error', message }),
          },
        );
      });

    // 6. Execute bounded multi-turn tool loop (session-isolated even if user switches tabs/sessions)
    const inTurnToolTurns: ConversationTurnCandidate[] = [
      { id: userMsgId, role: 'user', content: userContent },
    ];
    let currentInspection = inspection;
    let cumulativeTokens = 0;
    let latestTps = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const outcome = await runStep(currentInspection);

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

      cumulativeTokens += outcome.totalTokens;
      if (outcome.tokensPerSecond > 0) {
        latestTps = outcome.tokensPerSecond;
      }

      const hasToolCalls =
        outcome.stopReason === 'tool_calls' &&
        outcome.toolCalls &&
        outcome.toolCalls.length > 0 &&
        round < MAX_TOOL_ROUNDS - 1;

      if (!hasToolCalls) {
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

      // Discard any partial tool-preamble whitespace if nothing meaningful streamed, or let it finish naturally
      const roundToolCalls = outcome.toolCalls!;
      const compactCallsForBudget: ToolCallRecord[] = [];

      inTurnToolTurns.push({
        id: `tool_req_${round}_${createUuid().slice(0, 6)}`,
        role: 'assistant',
        content: outcome.rawText,
        toolCalls: roundToolCalls,
      });

      for (const tc of roundToolCalls) {
        if (tc.function.name === CREATE_FILE_TOOL_NAME) {
          const exec = executeCreateFileTool(tc.function.arguments, createUuid);
          if (exec.ok) {
            collectedFiles.push(exec.artifact);
            toolActivityLabels.push(`Created ${exec.artifact.filename}`);
            logger.info(
              'chat',
              `Tool create_file wrote '${exec.artifact.filename}' (${countLines(exec.artifact.content)} lines)`,
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
            compactCallsForBudget.push(tc);
          }
          inTurnToolTurns.push({
            id: `tool_res_${tc.id}`,
            role: 'tool',
            toolCallId: tc.id,
            name: tc.function.name,
            content: exec.toolResultJson,
          });
        } else {
          const errJson = JSON.stringify({
            status: 'error',
            error: `Unsupported tool '${tc.function.name}'. Only '${CREATE_FILE_TOOL_NAME}' is available.`,
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

      // Re-assemble context for the next round (with compact fallback if full tool payload overflows tiny windows)
      let nextAssembly = assembleContext(
        {
          ...baseAssemblyCandidates,
          currentUserMessage: '',
          conversationTurns: [...historyTurns, ...inTurnToolTurns],
        },
        {
          modelContextLimit: effectiveLimit,
          outputReservePct: workspace.settings.outputReservePct,
          safetyMarginPct: workspace.settings.safetyMarginPct,
          templateType: activeModel.chatTemplate,
          allowEmptyUserMessage: true,
        },
      );

      if (!nextAssembly.ok && nextAssembly.code === 'MANDATORY_EXCEEDS_BUDGET') {
        const compactedTurns = inTurnToolTurns.map((t) =>
          t.role === 'assistant' && t.toolCalls === roundToolCalls
            ? { ...t, toolCalls: compactCallsForBudget }
            : t,
        );
        nextAssembly = assembleContext(
          {
            ...baseAssemblyCandidates,
            currentUserMessage: '',
            conversationTurns: [...historyTurns, ...compactedTurns],
          },
          {
            modelContextLimit: effectiveLimit,
            outputReservePct: workspace.settings.outputReservePct,
            safetyMarginPct: workspace.settings.safetyMarginPct,
            templateType: activeModel.chatTemplate,
            allowEmptyUserMessage: true,
          },
        );
      }

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
  }, [
    composerText,
    attachedFile,
    activeSession,
    activeModel,
    generatingSessionId,
    workspace.memoryNotes,
    workspace.settings,
    logger,
  ]);

  const handleStopGeneration = useCallback(() => {
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
      logger.info('memory', `Saved chat reply as memory note '${newNote.title}'`);
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
    logger.info('memory', `Generated draft session summary '${draft.title}' (awaiting approval)`);
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
        `Created ${isSummary ? 'draft summary' : 'memory note'} '${note.title}' (pinned=${note.isPinned})`,
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
      if (controllerRef.current?.isLoaded()) {
        controllerRef.current.unloadModel();
      }
      setWorkspace((prev) => {
        const lmProfile = prev.models.find((m) => m.backendType === 'lm_studio');
        const nextActiveModelId = lmProfile ? lmProfile.id : prev.activeModelId;
        if (lmProfile && controllerRef.current) {
          const effectiveCtx = getEffectiveContextLimit(
            lmProfile,
            prev.settings.contextLimitOverride,
          );
          controllerRef.current.loadModel({
            ...lmProfile,
            contextOverride: effectiveCtx,
          });
        }
        return {
          ...prev,
          activeModelId: nextActiveModelId,
          settings: {
            ...prev.settings,
            activeBackendType: lmProfile ? 'lm_studio' : prev.settings.activeBackendType,
            selectedLmModel: modelName,
          },
        };
      });
      logger.info('settings', `Selected LM Studio server model '${modelName}' (previous model unloaded)`);
    },
    [logger],
  );

  const handleLockVault = useCallback(
    async (passphrase: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      controllerRef.current?.cancelGeneration();
      const res = await sealWorkspaceVault(workspace, passphrase, logger);
      if (res.ok) {
        setVaultLocked(true);
      }
      return res;
    },
    [workspace, logger],
  );

  const handleUnlockVault = useCallback(
    async (passphrase: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const res = await unsealWorkspaceVault(passphrase, logger);
      if (!res.ok) {
        return res;
      }
      setWorkspace(res.workspace);
      setLastTurnInspection(null);
      setVaultLocked(false);
      return { ok: true };
    },
    [logger],
  );

  if (vaultLocked) {
    return <VaultLockOverlay onUnlock={handleUnlockVault} />;
  }

  const backendLabel =
    activeModel?.backendType === 'lm_studio' ? 'LM Studio (Loopback)' : 'Offline Mock';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--lc-bg)] text-[var(--lc-ink)]">
      {/* Left Navigation Sidebar */}
      <SidebarNav
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        sessions={workspace.sessions}
        activeSessionId={workspace.activeSessionId}
        generatingSessionId={generatingSessionId}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        onDeleteSession={handleDeleteSession}
      />

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
              />

              {previewFile && previewFile.sessionId === activeSession.id ? (
                <FilePreviewPanel
                  file={previewFile.file}
                  onClose={() => setPreviewFile(null)}
                />
              ) : (
                <ContextPanel
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
                />
              )}
            </>
          )}

          {currentTab === 'models' && (
            <ModelsView
              models={workspace.models}
              activeModelId={workspace.activeModelId}
              workerStatus={workerStatus}
              globalContextOverride={workspace.settings.contextLimitOverride}
              lmStudioEndpoint={workspace.settings.lmStudioEndpoint}
              onSelectActiveModel={handleSelectActiveModel}
              onLoadModel={handleLoadModel}
              onUnloadModel={handleUnloadModel}
              onAddModel={(profile) => {
                setWorkspace((prev) => ({
                  ...prev,
                  models: [...prev.models, profile],
                }));
                logger.info('models', `Added model profile '${profile.name}'`);
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
              onLockVault={handleLockVault}
              onClearDiagnostics={() => logger.clear()}
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
