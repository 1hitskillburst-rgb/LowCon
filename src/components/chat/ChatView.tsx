import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  BookmarkPlus,
  BookOpen,
  Brain,
  Calculator,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  FileCode2,
  FilePenLine,
  FileText,
  Globe,
  Image,
  Paperclip,
  RotateCcw,
  Search,
  Square,
  Table2,
  X,
} from 'lucide-react';
import { detectArtifactPreviewKind, type ArtifactPreviewKind } from '../../core/artifactPreview';
import { getPackedTokens } from '../../core/context';
import {
  resolveModelDisplayName,
  resolveModelOrigin,
  type ModelOrigin,
} from '../../core/modelNames';
import { formatNumber, formatRelativeTime } from '../../core/privacy';
import { getTpsColorVar } from '../../core/theme';
import { shouldIndexAttachedFile } from '../../core/tier1Tools';
import { countLines, getFileExtensionBadge } from '../../core/tools';
import type {
  ChatWidthPreset,
  ContextSegmentKey,
  EffortLevel,
  GeneratedFileArtifact,
  ModelProfile,
  Session,
  WorkerStatus,
} from '../../core/types';
import { ContextStrip } from './ContextBudgetViz';
import { MarkdownMessage } from './MarkdownMessage';
import { ModelOriginIcon } from './ModelOriginIcon';

const EFFORT_OPTIONS: Array<{ id: EffortLevel; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
];

const CHAT_WIDTH_CLASSES: Record<ChatWidthPreset, { outerPad: string; innerMax: string }> = {
  default: { outerPad: 'px-6', innerMax: 'max-w-[660px]' },
  medium: { outerPad: 'px-6', innerMax: 'max-w-[840px]' },
  wide: { outerPad: 'px-6', innerMax: 'max-w-[1060px]' },
  fill: { outerPad: 'px-2.5', innerMax: 'max-w-none' },
};

const ARTIFACT_KIND_META: Record<
  ArtifactPreviewKind,
  { label: string; badge: string | null; icon: React.ReactNode }
> = {
  markdown: {
    label: 'Markdown',
    badge: 'Preview',
    icon: <FileText className="h-4 w-4" />,
  },
  csv: {
    label: 'Table',
    badge: 'Preview',
    icon: <Table2 className="h-4 w-4" />,
  },
  svg: {
    label: 'SVG',
    badge: 'Preview',
    icon: <Image className="h-4 w-4" />,
  },
  html: {
    label: 'HTML',
    badge: 'Sandbox',
    icon: <Globe className="h-4 w-4" />,
  },
  code: {
    label: 'Code',
    badge: null,
    icon: <Code2 className="h-4 w-4" />,
  },
};

function renderToolActivityBadge(label: string, idx: number): React.ReactNode {
  const lower = label.toLowerCase();
  let icon: React.ReactNode = <FileCode2 className="h-3 w-3 shrink-0" />;
  let tone =
    'border-[var(--lc-panel-line)] bg-[var(--lc-panel)]/70 text-[var(--lc-panel-ink2)]';

  if (lower.startsWith('failed ')) {
    icon = <AlertCircle className="h-3 w-3 shrink-0" />;
    tone = 'border-[var(--lc-danger)]/35 bg-[var(--lc-danger)]/8 text-[var(--lc-danger)]';
  } else if (lower.startsWith('updated ') || lower.startsWith('editing ')) {
    icon = <FilePenLine className="h-3 w-3 shrink-0 text-[var(--lc-accent)]" />;
    tone = 'border-[var(--lc-accent)]/30 bg-[var(--lc-accent)]/8 text-[var(--lc-ink2)]';
  } else if (lower.startsWith('calculated') || lower.startsWith('calculating')) {
    icon = <Calculator className="h-3 w-3 shrink-0 text-[var(--lc-accent)]" />;
  } else if (lower.startsWith('read ') || lower.startsWith('reading ')) {
    icon = <BookOpen className="h-3 w-3 shrink-0 text-[var(--lc-accent)]" />;
  } else if (lower.startsWith('searched memory') || lower.startsWith('searching ')) {
    icon = <Search className="h-3 w-3 shrink-0 text-[var(--lc-accent)]" />;
  } else if (lower.startsWith('saved note') || lower.startsWith('saving memory') || lower.startsWith('saved to files') || lower.startsWith('updated files') || lower.startsWith('saving to files')) {
    icon = <BookmarkPlus className="h-3 w-3 shrink-0 text-[var(--lc-success)]" />;
    tone = 'border-[var(--lc-success)]/30 bg-[var(--lc-success)]/8 text-[var(--lc-success)]';
  }

  return (
    <span
      key={`${idx}-${label}`}
      className={`inline-flex items-center gap-1 rounded-[5px] border px-2 py-0.5 text-[11.5px] font-medium ${tone}`}
    >
      {icon}
      <span>{label}</span>
    </span>
  );
}

interface ThinkingProcessBoxProps {
  messageId: string;
  thinkingContent: string;
  thinkingLabel: string;
  isExpanded: boolean;
  isThinkingActive: boolean;
  isStreaming: boolean;
  onToggle: () => void;
}

const ThinkingProcessBox: React.FC<ThinkingProcessBoxProps> = ({
  messageId,
  thinkingContent,
  thinkingLabel,
  isExpanded,
  isThinkingActive,
  isStreaming,
  onToggle,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    if (!isExpanded) {
      shouldAutoScrollRef.current = true;
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    if (shouldAutoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [isExpanded, isStreaming, thinkingContent]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= 40;
  };

  return (
    <div className="rounded-[8px] border border-[var(--lc-panel-line)] bg-[var(--lc-panel)]/85">
      <button
        type="button"
        aria-expanded={isExpanded}
        data-testid={`thinking-toggle-${messageId}`}
        onClick={() => {
          if (!isExpanded) {
            shouldAutoScrollRef.current = true;
          }
          onToggle();
        }}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12.5px] font-medium text-[var(--lc-panel-ink2)] hover:text-[var(--lc-panel-ink)]"
      >
        <span className="inline-flex items-center gap-1.5">
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className={isThinkingActive ? 'lowcon-streaming-glow font-semibold' : ''}>
            {thinkingLabel}
          </span>
        </span>
        <span className="text-[11px] text-[var(--lc-panel-mute)]">
          {isExpanded ? 'Hide' : 'Show'}
        </span>
      </button>
      {isExpanded && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          data-testid={`thinking-content-${messageId}`}
          className="max-h-72 overflow-y-auto border-t border-[var(--lc-panel-line)] px-3 py-2.5"
        >
          <MarkdownMessage content={thinkingContent} compact />
        </div>
      )}
    </div>
  );
};

interface ChatViewProps {
  session: Session;
  models: ModelProfile[];
  activeModelId: string;
  onSelectActiveModel: (modelId: string) => void;
  connectedLmModels: string[];
  selectedLmModel: string;
  modelDisplayAliases?: Record<string, string>;
  modelIconOverrides?: Record<string, ModelOrigin>;
  onSelectLmModel: (modelName: string) => void;
  effortLevel: EffortLevel;
  chatWidth?: ChatWidthPreset;
  onChangeEffortLevel: (level: EffortLevel) => void;
  backendLabel: string;
  workerStatus: WorkerStatus;
  composerText: string;
  onComposerTextChange: (text: string) => void;
  attachedFile: { name: string; content: string } | null;
  onAttachFile: (file: { name: string; content: string } | null) => void;
  memoryRetrievalEnabled: boolean;
  onToggleMemoryRetrieval: (enabled: boolean) => void;
  isGenerating: boolean;
  liveTokensPerSecond?: number | null;
  hoveredSegment: ContextSegmentKey | null;
  onHoverSegment: (key: ContextSegmentKey | null) => void;
  onSendMessage: () => void;
  onStopGeneration: () => void;
  onNewSession: () => void;
  onSummarizeSession: () => boolean;
  onReviewSummaries: () => void;
  onOpenSources: (sources: string[]) => void;
  onSaveAsNote: (content: string, messageId: string) => void;
  activePreviewFileId?: string | null;
  onOpenFilePreview: (file: GeneratedFileArtifact) => void;
  workspaceFilenames?: Set<string>;
  onSaveArtifactToWorkspaceFiles?: (file: GeneratedFileArtifact) => void;
  onRetryUserMessage?: (messageId: string) => void;
}

export const ChatView: React.FC<ChatViewProps> = ({
  session,
  models,
  activeModelId,
  onSelectActiveModel,
  connectedLmModels,
  selectedLmModel,
  modelDisplayAliases,
  modelIconOverrides,
  onSelectLmModel,
  effortLevel,
  chatWidth = 'default',
  onChangeEffortLevel,
  backendLabel,
  workerStatus,
  composerText,
  onComposerTextChange,
  attachedFile,
  onAttachFile,
  memoryRetrievalEnabled,
  onToggleMemoryRetrieval,
  isGenerating,
  liveTokensPerSecond,
  hoveredSegment,
  onHoverSegment,
  onSendMessage,
  onStopGeneration,
  onNewSession,
  onSummarizeSession,
  onReviewSummaries,
  onOpenSources,
  onSaveAsNote,
  activePreviewFileId,
  onOpenFilePreview,
  workspaceFilenames,
  onSaveArtifactToWorkspaceFiles,
  onRetryUserMessage,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const prevMessageCountRef = useRef(session.messages.length);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [savedNoteMsgId, setSavedNoteMsgId] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [summaryCreatedNotice, setSummaryCreatedNotice] = useState(false);
  const [expandedThinkingIds, setExpandedThinkingIds] = useState<Record<string, boolean>>({});
  const [showModelEffortMenu, setShowModelEffortMenu] = useState(false);

  const widthLayout = CHAT_WIDTH_CLASSES[chatWidth] ?? CHAT_WIDTH_CLASSES.default;
  const lastMessage = session.messages[session.messages.length - 1];
  const lastMessageId = lastMessage?.id;

  useEffect(() => {
    setSummaryCreatedNotice(false);
    shouldAutoScrollRef.current = true;
    prevMessageCountRef.current = session.messages.length;
    const el = transcriptScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;

    const messageCountIncreased = session.messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = session.messages.length;

    if (messageCountIncreased) {
      shouldAutoScrollRef.current = true;
    }

    if (isGenerating && shouldAutoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (messageCountIncreased && shouldAutoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [
    isGenerating,
    session.messages.length,
    lastMessage?.content,
    lastMessage?.thinkingContent,
  ]);

  const handleTranscriptScroll = () => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= 80;
  };

  useEffect(() => {
    if (!showModelEffortMenu) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelEffortMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [showModelEffortMenu]);

  const activeModel = models.find((m) => m.id === activeModelId) ?? models[0];
  const activeModelDisplayName =
    activeModel?.backendType === 'lm_studio' && selectedLmModel
      ? resolveModelDisplayName(selectedLmModel, modelDisplayAliases)
      : activeModel?.name ?? 'Model';
  const activeModelOrigin = resolveModelOrigin(
    {
      modelId: activeModel?.backendType === 'lm_studio' ? selectedLmModel : undefined,
      profileName: activeModel?.name,
      architecture: activeModel?.architecture,
      backendType: activeModel?.backendType,
    },
    modelIconOverrides,
  );
  const activeEffortLabel =
    EFFORT_OPTIONS.find((e) => e.id === effortLevel)?.label ?? 'Medium';

  const hasValidTurns = session.messages.some(
    (m) => (m.role === 'user' || m.role === 'assistant') && !m.isError && m.content.trim().length > 0,
  );

  const workerStatusLabel =
    workerStatus.state === 'loaded'
      ? 'Worker ready'
      : workerStatus.state === 'generating'
        ? 'Streaming'
        : workerStatus.state === 'loading'
          ? 'Loading model'
          : workerStatus.state === 'error'
            ? 'Worker error'
            : 'No model loaded';

  const workerDotColor =
    workerStatus.state === 'loaded' || workerStatus.state === 'generating'
      ? 'var(--lc-success)'
      : workerStatus.state === 'error'
        ? 'var(--lc-danger)'
        : 'var(--lc-mute)';

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 128 * 1024) {
      setFileError('Local file exceeds 128 KB text attachment limit.');
      return;
    }
    try {
      const content = await file.text();
      onAttachFile({ name: file.name, content });
    } catch {
      setFileError('Failed to read selected local file.');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if ((composerText.trim() || attachedFile) && !isGenerating) {
        onSendMessage();
      }
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--lc-bg)] text-[var(--lc-ink)]">
      {/* Top Header Bar */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--lc-line)] bg-[var(--lc-bg)] px-7 py-3">
        <div className="flex items-center text-[13px]">
          <span className="text-[var(--lc-mute)]">Workspace /</span>
          <span className="ml-1 font-semibold text-[var(--lc-ink)]">Chat</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Real Worker Readiness Status */}
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--lc-ink2)]">
            <span
              aria-hidden="true"
              style={{ backgroundColor: workerDotColor }}
              className="h-[7px] w-[7px] rounded-full"
            />
            <span>{workerStatusLabel}</span>
            {workerStatus.state === 'generating' &&
              liveTokensPerSecond !== null &&
              liveTokensPerSecond !== undefined &&
              liveTokensPerSecond > 0 && (
                <>
                  <span>·</span>
                  <span
                    data-testid="live-tps-indicator"
                    style={{ color: getTpsColorVar(liveTokensPerSecond) }}
                    className="font-semibold tabular-nums"
                  >
                    {liveTokensPerSecond.toFixed(1)} tok/s
                  </span>
                </>
              )}
          </div>

          {/* Active Backend Badge */}
          <div className="flex items-center gap-1.5 rounded-[6px] border border-[var(--lc-panel-line)] bg-[var(--lc-panel)] px-2 py-1 text-[11.5px] font-semibold text-[var(--lc-panel-ink2)]">
            <span aria-hidden="true" className="h-[6px] w-[6px] rounded-full bg-[var(--lc-success)]" />
            <span>{backendLabel}</span>
          </div>

          {/* Active Model Selector (wired directly to InferenceController) */}
          <label className="sr-only" htmlFor="chat-active-model-select">
            Active model
          </label>
          <select
            id="chat-active-model-select"
            value={
              activeModel?.backendType === 'lm_studio' &&
              selectedLmModel &&
              connectedLmModels.includes(selectedLmModel)
                ? `lm::${selectedLmModel}`
                : activeModelId
            }
            onChange={(e) => {
              const val = e.target.value;
              if (val.startsWith('lm::')) {
                onSelectLmModel(val.slice(4));
              } else {
                onSelectActiveModel(val);
              }
            }}
            className="max-w-[320px] rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2.5 py-1 text-[12.5px] font-semibold text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {connectedLmModels.length > 0 && (
              <optgroup label="LM Studio Server Models">
                {connectedLmModels.map((lmName) => (
                  <option key={`lm-${lmName}`} value={`lm::${lmName}`}>
                    {resolveModelDisplayName(lmName, modelDisplayAliases)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      </header>

      {/* Scrollable Transcript Column */}
      <div
        ref={transcriptScrollRef}
        onScroll={handleTranscriptScroll}
        data-testid="chat-transcript-scroll"
        className={`min-h-0 flex-1 overflow-y-auto py-5 ${widthLayout.outerPad}`}
      >
        <div className={`mx-auto w-full ${widthLayout.innerMax}`}>
          {/* Session Title Header */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-[24px] leading-snug font-bold tracking-tight text-[var(--lc-ink)]">
                {session.title}
              </h1>
              <p className="mt-0.5 text-[13px] text-[var(--lc-mute)]">{session.subtitle}</p>
              {session.taskGoal?.trim() && (
                <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-[6px] border border-[var(--lc-accent)]/25 bg-[var(--lc-accent)]/10 px-2.5 py-1 text-[12px] text-[var(--lc-accent)]">
                  <span className="shrink-0 font-semibold">Task goal:</span>
                  <span className="truncate">{session.taskGoal}</span>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {hasValidTurns && (
                <button
                  type="button"
                  disabled={isGenerating}
                  onClick={() => {
                    if (onSummarizeSession()) {
                      setSummaryCreatedNotice(true);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[13px] text-[var(--lc-surf-ink2)] transition-colors hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Summarize chat</span>
                </button>
              )}
              <button
                type="button"
                onClick={onNewSession}
                className="shrink-0 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3 py-1.5 text-[13px] text-[var(--lc-surf-ink2)] transition-colors hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)]"
              >
                New session
              </button>
            </div>
          </div>

          {summaryCreatedNotice && (
            <div
              role="status"
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[var(--lc-success)]/30 bg-[var(--lc-success)]/10 px-3.5 py-2 text-[12.5px] text-[var(--lc-success)]"
            >
              <span>
                Draft summary saved (unapproved). Approve it in Memory → Summaries to include it in prompts.
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onReviewSummaries}
                  className="rounded-[5px] bg-[var(--lc-success)] px-2.5 py-1 text-[12px] font-semibold text-[var(--lc-success-contrast)] hover:opacity-90"
                >
                  Review &amp; Approve
                </button>
                <button
                  type="button"
                  onClick={() => setSummaryCreatedNotice(false)}
                  aria-label="Dismiss summary notice"
                  className="rounded p-0.5 opacity-75 hover:opacity-100"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Conversation Stream */}
          <div className="mt-7 space-y-6">
            {session.messages.length === 0 ? (
              <div className="rounded-[10px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-5 py-6 text-[var(--lc-surf-ink)]">
                <div className="text-[14px] font-semibold text-[var(--lc-surf-ink)]">
                  Deterministic low-context session ready
                </div>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--lc-surf-ink2)]">
                  Every turn computes prompt tokens, reserves reply space and safety margin first,
                  injects pinned project rules unconditionally, and never silently clips your
                  message.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {[
                    'Why does my smaller model lose earlier constraints in long chats?',
                    'Explain how local memory scoring and pinned rules work',
                  ].map((promptSample) => (
                    <button
                      key={promptSample}
                      type="button"
                      onClick={() => onComposerTextChange(promptSample)}
                      className="rounded-[6px] border border-[var(--lc-line)] bg-[var(--lc-bg)] px-3 py-1.5 text-left text-[12.5px] text-[var(--lc-ink2)] transition-colors hover:bg-[var(--lc-hover)] hover:text-[var(--lc-ink)]"
                    >
                      {promptSample}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              session.messages.map((msg) => {
                const isMsgStreaming =
                  isGenerating && msg.role === 'assistant' && msg.id === lastMessageId;
                const hasThinking = Boolean(msg.thinkingContent?.trim());
                const hasVisibleContent = msg.content.trim().length > 0;
                const isThinkingExpanded = Boolean(expandedThinkingIds[msg.id]);
                const isThinkingActive = isMsgStreaming && hasThinking && !hasVisibleContent;
                const thinkingLabel = isThinkingActive
                  ? 'Thinking...'
                  : msg.thinkingDurationMs
                    ? `Thought for ${(msg.thinkingDurationMs / 1000).toFixed(1)}s`
                    : 'Thought process';
                const outputReserveTokens = msg.turnBudget?.segments.find(
                  (s) => s.key === 'out',
                )?.tokens;

                return (
                  <article key={msg.id} className="space-y-1.5">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-[13px] font-bold text-[var(--lc-ink)]">{msg.authorName}</span>
                      <span className="text-[12px] text-[var(--lc-mute)]">
                        {formatRelativeTime(msg.createdAt)}
                        {msg.modelInfo ? ` · ${msg.modelInfo}` : ''}
                        {msg.tokensPerSecond && msg.tokensPerSecond > 0 && (
                          <>
                            {' · '}
                            <span
                              style={{ color: getTpsColorVar(msg.tokensPerSecond) }}
                              className="font-semibold tabular-nums"
                            >
                              {msg.tokensPerSecond.toFixed(1)} tok/s
                            </span>
                          </>
                        )}
                      </span>
                    </div>

                    {msg.role === 'user' ? (() => {
                      const displayPromptText =
                        msg.attachedFiles && msg.attachedFiles.length > 0
                          ? msg.content.replace(/\n\n\[Attached local file[\s\S]*$/, '')
                          : msg.content;
                      return (
                        <div className="space-y-1.5">
                          <div className="space-y-2 border-l-[3px] border-[var(--lc-quote-bar)] py-0.5 pl-4 text-[15px] leading-relaxed text-[var(--lc-ink)]">
                            {msg.attachedFiles && msg.attachedFiles.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {msg.attachedFiles.map((att) => (
                                  <span
                                    key={`${msg.id}-att-${att.name}`}
                                    className="inline-flex items-center gap-1.5 rounded-[6px] border border-[var(--lc-panel-line)] bg-[var(--lc-panel)] px-2.5 py-1 text-[12px] text-[var(--lc-panel-ink)]"
                                  >
                                    <Paperclip className="h-3 w-3 shrink-0 text-[var(--lc-panel-mute)]" />
                                    <span className="font-medium">{att.name}</span>
                                    <span className="text-[var(--lc-panel-mute)]">
                                      ({countLines(att.content)} lines)
                                    </span>
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="whitespace-pre-wrap">{displayPromptText}</div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2 pl-4">
                            <button
                              type="button"
                              data-testid={`copy-user-message-${msg.id}`}
                              onClick={() => {
                                void navigator.clipboard?.writeText(displayPromptText || msg.content);
                                setCopiedId(msg.id);
                                setTimeout(() => setCopiedId(null), 1400);
                              }}
                              className="inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[12px] text-[var(--lc-mute)] transition-colors hover:bg-[var(--lc-hover)] hover:text-[var(--lc-ink)]"
                            >
                              {copiedId === msg.id ? (
                                <Check className="h-3.5 w-3.5 text-[var(--lc-success)]" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                              <span>{copiedId === msg.id ? 'Copied' : 'Copy'}</span>
                            </button>

                            {onRetryUserMessage && (
                              <button
                                type="button"
                                data-testid={`retry-user-message-${msg.id}`}
                                disabled={isGenerating}
                                onClick={() => onRetryUserMessage(msg.id)}
                                title={
                                  isGenerating
                                    ? 'Wait for the current response to finish before retrying'
                                    : 'Retry this prompt'
                                }
                                className="inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[12px] text-[var(--lc-mute)] transition-colors hover:bg-[var(--lc-hover)] hover:text-[var(--lc-ink)] disabled:cursor-not-allowed disabled:opacity-45"
                              >
                                <RotateCcw className="h-3.5 w-3.5" />
                                <span>Retry</span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })() : (
                      <div className="space-y-3 pt-0.5">
                        {msg.toolActivity && msg.toolActivity.length > 0 && (
                          <div
                            data-testid={`tool-activity-${msg.id}`}
                            className="flex flex-wrap items-center gap-1.5"
                          >
                            {msg.toolActivity.map((label, idx) =>
                              renderToolActivityBadge(label, idx),
                            )}
                          </div>
                        )}

                        {hasThinking && (
                          <ThinkingProcessBox
                            messageId={msg.id}
                            thinkingContent={msg.thinkingContent ?? ''}
                            thinkingLabel={thinkingLabel}
                            isExpanded={isThinkingExpanded}
                            isThinkingActive={isThinkingActive}
                            isStreaming={isMsgStreaming}
                            onToggle={() =>
                              setExpandedThinkingIds((prev) => ({
                                ...prev,
                                [msg.id]: !prev[msg.id],
                              }))
                            }
                          />
                        )}

                        {hasVisibleContent ? (
                          msg.isError ? (
                            <div className="rounded-[6px] border border-[var(--lc-danger)]/35 bg-[var(--lc-danger)]/8 px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-[var(--lc-danger)]">
                              {msg.content}
                            </div>
                          ) : (
                            <MarkdownMessage content={msg.content} />
                          )
                        ) : isMsgStreaming ? (
                          <p
                            data-testid="streaming-placeholder"
                            className="lowcon-streaming-glow text-[14px] font-medium italic"
                          >
                            Streaming response within verified context budget...
                          </p>
                        ) : (
                          <div
                            data-testid="empty-response-notice"
                            className="rounded-[6px] border border-[var(--lc-panel-line)] bg-[var(--lc-panel)] px-3.5 py-2.5 text-[13px] text-[var(--lc-panel-ink2)]"
                          >
                            {msg.stopReason === 'max_tokens' && hasThinking
                              ? `Output reply reserve (${outputReserveTokens ?? 'current'} tokens) was reached during thinking before visible answer text started. Increase Output Reply Reserve in Settings or inspect the Thought process above.`
                              : 'Model finished without returning visible answer text.'}
                          </div>
                        )}

                        {msg.aside && (
                          <div className="border-l-[2px] border-[var(--lc-seg-tpl)] pl-3.5 text-[13px] italic text-[var(--lc-ink2)]">
                            {msg.aside}
                          </div>
                        )}

                        {/* Generated File Artifact Cards */}
                        {msg.generatedFiles && msg.generatedFiles.length > 0 && (
                          <div className="flex flex-col gap-2 pt-1">
                            {msg.generatedFiles.map((file) => {
                              const isPreviewActive = activePreviewFileId === file.id;
                              const extBadge = getFileExtensionBadge(file.filename, file.language);
                              const lines = countLines(file.content);
                              const previewKind = detectArtifactPreviewKind(
                                file.filename,
                                file.language,
                              );
                              const kindMeta = ARTIFACT_KIND_META[previewKind];
                              const inWorkspace = Boolean(
                                workspaceFilenames?.has(file.filename.toLowerCase()),
                              );
                              return (
                                <div key={file.id} className="flex max-w-[460px] items-center gap-2">
                                  <button
                                    type="button"
                                    data-testid={`file-artifact-card-${file.id}`}
                                    onClick={() => onOpenFilePreview(file)}
                                    className={`group flex min-w-0 flex-1 items-center justify-between gap-3 rounded-[10px] border px-3.5 py-2.5 text-left transition-colors ${
                                      isPreviewActive
                                        ? 'border-[var(--lc-accent)] bg-[var(--lc-accent)]/8'
                                        : 'border-[var(--lc-surf-line)] bg-[var(--lc-surface)] hover:border-[var(--lc-accent)]/60 hover:bg-[var(--lc-surf-hover)]/60'
                                    }`}
                                  >
                                    <div className="flex min-w-0 items-center gap-3">
                                      <div
                                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border ${
                                          isPreviewActive
                                            ? 'border-[var(--lc-accent)]/40 bg-[var(--lc-accent)]/15 text-[var(--lc-accent)]'
                                            : 'border-[var(--lc-surf-line)] bg-[var(--lc-surf-hover)] text-[var(--lc-surf-ink2)] group-hover:text-[var(--lc-surf-ink)]'
                                        }`}
                                      >
                                        {kindMeta.icon}
                                      </div>
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-1.5">
                                          <span className="truncate text-[13.5px] font-semibold text-[var(--lc-surf-ink)]">
                                            {file.title}
                                          </span>
                                          {kindMeta.badge && (
                                            <span
                                              data-testid={`file-artifact-rich-badge-${file.id}`}
                                              className="shrink-0 rounded-[4px] border border-[var(--lc-accent)]/30 bg-[var(--lc-accent)]/10 px-1.5 py-[1px] text-[10px] font-semibold text-[var(--lc-accent)]"
                                            >
                                              {kindMeta.badge}
                                            </span>
                                          )}
                                          {file.isEdited && (
                                            <span
                                              data-testid={`file-artifact-edited-badge-${file.id}`}
                                              className="shrink-0 rounded-[4px] border border-[var(--lc-success)]/35 bg-[var(--lc-success)]/10 px-1.5 py-[1px] text-[10px] font-semibold text-[var(--lc-success)]"
                                            >
                                              Edited
                                            </span>
                                          )}
                                        </div>
                                        <div className="truncate text-[12px] text-[var(--lc-surf-mute)]">
                                          {kindMeta.label} · {extBadge} · {lines}{' '}
                                          {lines === 1 ? 'line' : 'lines'}
                                        </div>
                                      </div>
                                    </div>
                                    <ChevronRight
                                      className={`h-4 w-4 shrink-0 transition-transform ${
                                        isPreviewActive
                                          ? 'text-[var(--lc-accent)]'
                                          : 'text-[var(--lc-surf-mute)] group-hover:translate-x-0.5 group-hover:text-[var(--lc-surf-ink)]'
                                      }`}
                                    />
                                  </button>
                                  {onSaveArtifactToWorkspaceFiles && (
                                    <button
                                      type="button"
                                      data-testid={`save-artifact-to-files-${file.id}`}
                                      onClick={() => onSaveArtifactToWorkspaceFiles(file)}
                                      title={
                                        inWorkspace
                                          ? 'Update copy in Files tab'
                                          : 'Save to persistent Files tab'
                                      }
                                      className={`inline-flex shrink-0 items-center gap-1 rounded-[8px] border px-2.5 py-2 text-[11.5px] font-medium transition-colors ${
                                        inWorkspace
                                          ? 'border-[var(--lc-success)]/35 bg-[var(--lc-success)]/10 text-[var(--lc-success)] hover:bg-[var(--lc-success)]/15'
                                          : 'border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)]'
                                      }`}
                                    >
                                      {inWorkspace ? (
                                        <>
                                          <Check className="h-3.5 w-3.5" />
                                          <span>In Files</span>
                                        </>
                                      ) : (
                                        <>
                                          <BookmarkPlus className="h-3.5 w-3.5" />
                                          <span>Save</span>
                                        </>
                                      )}
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Message Action Row */}
                        {hasVisibleContent && !msg.isError && (
                          <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            <button
                              type="button"
                              onClick={() => {
                                void navigator.clipboard?.writeText(msg.content);
                                setCopiedId(msg.id);
                                setTimeout(() => setCopiedId(null), 1400);
                              }}
                              className="inline-flex items-center gap-1 rounded-[5px] px-2 py-1 text-[12px] text-[var(--lc-mute)] hover:bg-[var(--lc-hover)] hover:text-[var(--lc-ink)]"
                            >
                              {copiedId === msg.id ? (
                                <Check className="h-3.5 w-3.5 text-[var(--lc-success)]" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                              <span>{copiedId === msg.id ? 'Copied' : 'Copy'}</span>
                            </button>

                            {msg.sources.length > 0 && (
                              <button
                                type="button"
                                onClick={() => onOpenSources(msg.sources)}
                                className="rounded-[5px] px-2 py-1 text-[12px] text-[var(--lc-mute)] hover:bg-[var(--lc-hover)] hover:text-[var(--lc-ink)]"
                              >
                                View sources ({msg.sources.length})
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => {
                                onSaveAsNote(msg.content, msg.id);
                                setSavedNoteMsgId(msg.id);
                                setTimeout(() => setSavedNoteMsgId(null), 1800);
                              }}
                              className="rounded-[5px] px-2 py-1 text-[12px] text-[var(--lc-mute)] hover:bg-[var(--lc-hover)] hover:text-[var(--lc-ink)]"
                            >
                              {savedNoteMsgId === msg.id ? 'Saved to Memory ✓' : 'Save as note'}
                            </button>
                          </div>
                        )}

                        {/* Per-Turn Context Strip */}
                        {msg.turnBudget && (
                          <div className="pt-2">
                            <div className="mb-1.5 flex items-center justify-between text-[12px]">
                              <span className="font-semibold text-[var(--lc-ink)]">
                                Context used for this reply
                              </span>
                              <span className="text-[var(--lc-mute)] tabular-nums">
                                {formatNumber(getPackedTokens(msg.turnBudget))} of{' '}
                                {formatNumber(msg.turnBudget.totalLimit)} tokens
                              </span>
                            </div>
                            <ContextStrip
                              budget={msg.turnBudget}
                              hoveredKey={hoveredSegment}
                              onHoverChange={onHoverSegment}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Bottom Composer Card */}
      <div className={`shrink-0 pb-4 pt-2 ${widthLayout.outerPad}`}>
        <div
          data-testid="chat-composer-card"
          className={`mx-auto w-full ${widthLayout.innerMax} rounded-[12px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-4 py-3 text-[var(--lc-surf-ink)] shadow-xs focus-within:border-[var(--lc-accent)]`}
        >
          {attachedFile && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-[6px] border border-[var(--lc-panel-line)] bg-[var(--lc-panel)] px-2.5 py-1 text-[12px] text-[var(--lc-panel-ink)]">
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                <span className="truncate">
                  Attached local file: <strong>{attachedFile.name}</strong> (
                  {formatNumber(countLines(attachedFile.content))} lines ·{' '}
                  {formatNumber(attachedFile.content.length)} chars)
                </span>
                {shouldIndexAttachedFile(attachedFile.content) && (
                  <span
                    data-testid="attached-file-indexed-badge"
                    className="shrink-0 rounded-[4px] border border-[var(--lc-accent)]/30 bg-[var(--lc-accent)]/10 px-1.5 py-[1px] text-[10.5px] font-semibold text-[var(--lc-accent)]"
                  >
                    Indexed · chunked read
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => onAttachFile(null)}
                aria-label="Remove attached file"
                className="ml-2 shrink-0 text-[var(--lc-panel-mute)] hover:text-[var(--lc-danger)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {fileError && (
            <div className="mb-2 text-[12px] text-[var(--lc-danger)]" role="alert">
              {fileError}
            </div>
          )}

          <label className="sr-only" htmlFor="chat-composer-input">
            Message local model
          </label>
          <textarea
            id="chat-composer-input"
            value={composerText}
            onChange={(e) => onComposerTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Message local model. Nothing leaves this device."
            className="w-full resize-none border-0 bg-transparent text-[14.5px] leading-relaxed text-[var(--lc-surf-ink)] placeholder:text-[var(--lc-surf-mute)] focus:outline-none"
          />

          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.markdown,.log,.json,.csv,.tsv,.svg,.html,.htm,.yaml,.yml,.toml,.css,.sql,.sh,.rs,.ts,.tsx,.js,.jsx,.py,.go,.c,.cpp,.java"
                onChange={(e) => void handleFileChange(e)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach local file"
                title="Attach local file"
                className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)]"
              >
                <Paperclip className="h-3.5 w-3.5" />
              </button>

              {/* Model & Effort Popover Selector */}
              <div ref={modelMenuRef} className="relative">
                <button
                  type="button"
                  data-testid="composer-model-effort-trigger"
                  aria-expanded={showModelEffortMenu}
                  onClick={() => setShowModelEffortMenu((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[12.5px] font-medium text-[var(--lc-surf-ink)] hover:bg-[var(--lc-surf-hover)]"
                >
                  <ModelOriginIcon origin={activeModelOrigin} size={14} />
                  <span className="max-w-[180px] truncate">{activeModelDisplayName}</span>
                  <span className="text-[var(--lc-surf-mute)]">{activeEffortLabel}</span>
                  <ChevronDown className="h-3 w-3 text-[var(--lc-surf-mute)]" />
                </button>

                {showModelEffortMenu && (
                  <div
                    role="menu"
                    data-testid="composer-model-effort-menu"
                    className="absolute bottom-full left-0 z-40 mb-2 flex flex-col gap-2 sm:flex-row sm:items-end"
                  >
                    {/* Model list */}
                    <div className="w-[270px] rounded-[10px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-1.5 text-[var(--lc-surf-ink)] shadow-xl">
                      <div className="px-2.5 py-1 text-[11px] font-semibold text-[var(--lc-surf-mute)]">
                        Model
                      </div>
                      <div className="max-h-60 overflow-y-auto space-y-0.5">
                        {models.map((m) => {
                          const isSelected = m.id === activeModelId;
                          const itemOrigin = resolveModelOrigin(
                            {
                              modelId: m.id,
                              profileName: m.name,
                              architecture: m.architecture,
                              backendType: m.backendType,
                            },
                            modelIconOverrides,
                          );
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => {
                                onSelectActiveModel(m.id);
                                setShowModelEffortMenu(false);
                              }}
                              className={`flex w-full items-center justify-between gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                                isSelected
                                  ? 'bg-[var(--lc-surf-hover)] font-semibold text-[var(--lc-surf-ink)]'
                                  : 'text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]/70 hover:text-[var(--lc-surf-ink)]'
                              }`}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <ModelOriginIcon origin={itemOrigin} size={14} />
                                <span className="truncate">{m.name}</span>
                              </span>
                              {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--lc-accent)]" />}
                            </button>
                          );
                        })}

                        {connectedLmModels.length > 0 && (
                          <>
                            <div className="mt-1 border-t border-[var(--lc-surf-line)] px-2.5 pt-1.5 pb-0.5 text-[10.5px] font-semibold tracking-wide text-[var(--lc-surf-mute)] uppercase">
                              LM Studio Server Models
                            </div>
                            {connectedLmModels.map((lmName) => {
                              const isSelected =
                                activeModel?.backendType === 'lm_studio' &&
                                selectedLmModel === lmName;
                              const cleanLabel = resolveModelDisplayName(lmName, modelDisplayAliases);
                              const lmOrigin = resolveModelOrigin(
                                {
                                  modelId: lmName,
                                  backendType: 'lm_studio',
                                },
                                modelIconOverrides,
                              );
                              return (
                                <button
                                  key={lmName}
                                  type="button"
                                  title={lmName}
                                  onClick={() => {
                                    onSelectLmModel(lmName);
                                    setShowModelEffortMenu(false);
                                  }}
                                  className={`flex w-full items-center justify-between gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                                    isSelected
                                      ? 'bg-[var(--lc-surf-hover)] font-semibold text-[var(--lc-surf-ink)]'
                                      : 'text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]/70 hover:text-[var(--lc-surf-ink)]'
                                  }`}
                                >
                                  <span className="flex min-w-0 flex-1 items-center gap-2">
                                    <ModelOriginIcon origin={lmOrigin} size={14} />
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate">{cleanLabel}</div>
                                      {cleanLabel !== lmName && (
                                        <div className="truncate font-mono text-[10.5px] text-[var(--lc-surf-mute)]">
                                          {lmName}
                                        </div>
                                      )}
                                    </div>
                                  </span>
                                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--lc-accent)]" />}
                                </button>
                              );
                            })}
                          </>
                        )}
                      </div>
                    </div>

                    {/* Thinking Effort list */}
                    <div className="w-[175px] rounded-[10px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-1.5 text-[var(--lc-surf-ink)] shadow-xl">
                      <div className="px-2.5 py-1 text-[11px] font-semibold text-[var(--lc-surf-mute)]">
                        Thinking effort
                      </div>
                      <div className="space-y-0.5">
                        {EFFORT_OPTIONS.map((opt) => {
                          const isSelected = effortLevel === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              data-testid={`effort-option-${opt.id}`}
                              onClick={() => {
                                onChangeEffortLevel(opt.id);
                                setShowModelEffortMenu(false);
                              }}
                              className={`flex w-full items-center justify-between rounded-[6px] px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                                isSelected
                                  ? 'bg-[var(--lc-surf-hover)] font-semibold text-[var(--lc-surf-ink)]'
                                  : 'text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)]/70 hover:text-[var(--lc-surf-ink)]'
                              }`}
                            >
                              <span>{opt.label}</span>
                              {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--lc-accent)]" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => onToggleMemoryRetrieval(!memoryRetrievalEnabled)}
                aria-pressed={memoryRetrievalEnabled}
                className={`inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[12.5px] font-medium hover:bg-[var(--lc-surf-hover)] ${
                  memoryRetrievalEnabled ? 'text-[var(--lc-accent)]' : 'text-[var(--lc-surf-mute)]'
                }`}
              >
                <Brain className="h-3.5 w-3.5" />
                <span>{memoryRetrievalEnabled ? 'Memory on' : 'Memory off'}</span>
              </button>
            </div>

            {isGenerating ? (
              <button
                type="button"
                onClick={onStopGeneration}
                className="inline-flex items-center gap-1.5 rounded-[8px] bg-[var(--lc-danger)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--lc-danger-contrast)] hover:opacity-90"
              >
                <Square className="h-3 w-3 fill-current" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onSendMessage}
                disabled={!composerText.trim() && !attachedFile}
                className="rounded-[8px] bg-[var(--lc-accent)] px-4 py-1.5 text-[13px] font-semibold text-[var(--lc-accent-contrast)] transition-colors hover:bg-[var(--lc-accent-hover)] disabled:cursor-not-allowed disabled:opacity-45"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
