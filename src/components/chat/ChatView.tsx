import React, { useEffect, useRef, useState } from 'react';
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Paperclip,
  Square,
  X,
} from 'lucide-react';
import { getPackedTokens } from '../../core/context';
import { formatNumber, formatRelativeTime } from '../../core/privacy';
import type {
  ContextSegmentKey,
  ModelProfile,
  Session,
  WorkerStatus,
} from '../../core/types';
import { ContextStrip } from './ContextBudgetViz';
import { MarkdownMessage } from './MarkdownMessage';

interface ChatViewProps {
  session: Session;
  models: ModelProfile[];
  activeModelId: string;
  onSelectActiveModel: (modelId: string) => void;
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
}

export const ChatView: React.FC<ChatViewProps> = ({
  session,
  models,
  activeModelId,
  onSelectActiveModel,
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
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [savedNoteMsgId, setSavedNoteMsgId] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [summaryCreatedNotice, setSummaryCreatedNotice] = useState(false);
  const [expandedThinkingIds, setExpandedThinkingIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setSummaryCreatedNotice(false);
  }, [session.id]);

  const hasValidTurns = session.messages.some(
    (m) => (m.role === 'user' || m.role === 'assistant') && !m.isError && m.content.trim().length > 0,
  );

  const lastMessageId = session.messages[session.messages.length - 1]?.id;

  const workerStatusText =
    workerStatus.state === 'loaded'
      ? 'Worker ready'
      : workerStatus.state === 'generating'
        ? liveTokensPerSecond && liveTokensPerSecond > 0
          ? `Streaming · ${liveTokensPerSecond.toFixed(1)} tok/s`
          : 'Streaming'
        : workerStatus.state === 'loading'
          ? 'Loading model'
          : workerStatus.state === 'error'
            ? 'Worker error'
            : 'No model loaded';

  const workerDotColor =
    workerStatus.state === 'loaded' || workerStatus.state === 'generating'
      ? '#1D7A4E'
      : workerStatus.state === 'error'
        ? '#D9383A'
        : '#778091';

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
      if (composerText.trim() && !isGenerating) {
        onSendMessage();
      }
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-[#F7F8F9]">
      {/* Top Header Bar */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#D3D8DF] bg-[#F7F8F9] px-7 py-3">
        <div className="flex items-center text-[13px]">
          <span className="text-[#778091]">Workspace /</span>
          <span className="ml-1 font-semibold text-[#161B26]">Chat</span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Real Worker Readiness Status */}
          <div className="flex items-center gap-1.5 text-[12px] text-[#444D5C]">
            <span
              aria-hidden="true"
              style={{ backgroundColor: workerDotColor }}
              className="h-[7px] w-[7px] rounded-full"
            />
            <span>{workerStatusText}</span>
          </div>

          {/* Active Backend Badge */}
          <div className="flex items-center gap-1.5 rounded-[6px] border border-[#D3D8DF] bg-[#EEF0F3] px-2 py-1 text-[11.5px] font-semibold text-[#444D5C]">
            <span aria-hidden="true" className="h-[6px] w-[6px] rounded-full bg-[#1D7A4E]" />
            <span>{backendLabel}</span>
          </div>

          {/* Active Model Selector (wired directly to InferenceController) */}
          <label className="sr-only" htmlFor="chat-active-model-select">
            Active model
          </label>
          <select
            id="chat-active-model-select"
            value={activeModelId}
            onChange={(e) => onSelectActiveModel(e.target.value)}
            className="max-w-[320px] rounded-[6px] border border-[#D3D8DF] bg-white px-2.5 py-1 text-[12.5px] font-semibold text-[#161B26] focus:border-[#2A3FE0] focus:outline-none"
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Scrollable Transcript Column */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-[660px]">
          {/* Session Title Header */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-[24px] leading-snug font-bold tracking-tight text-[#161B26]">
                {session.title}
              </h1>
              <p className="mt-0.5 text-[13px] text-[#778091]">{session.subtitle}</p>
              {session.taskGoal?.trim() && (
                <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-[6px] border border-[#2A3FE0]/25 bg-[#2A3FE0]/8 px-2.5 py-1 text-[12px] text-[#2A3FE0]">
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
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-[#D3D8DF] bg-white px-3 py-1.5 text-[13px] text-[#444D5C] transition-colors hover:bg-[#DDE1E7] hover:text-[#161B26] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>Summarize chat</span>
                </button>
              )}
              <button
                type="button"
                onClick={onNewSession}
                className="shrink-0 rounded-[6px] border border-[#D3D8DF] bg-white px-3 py-1.5 text-[13px] text-[#444D5C] transition-colors hover:bg-[#DDE1E7] hover:text-[#161B26]"
              >
                New session
              </button>
            </div>
          </div>

          {summaryCreatedNotice && (
            <div
              role="status"
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[#1D7A4E]/30 bg-[#1D7A4E]/8 px-3.5 py-2 text-[12.5px] text-[#1D7A4E]"
            >
              <span>
                Draft summary saved (unapproved). Approve it in Memory → Summaries to include it in prompts.
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onReviewSummaries}
                  className="rounded-[5px] bg-[#1D7A4E] px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-[#16603d]"
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
              <div className="rounded-[10px] border border-[#D3D8DF] bg-white px-5 py-6">
                <div className="text-[14px] font-semibold text-[#161B26]">
                  Deterministic low-context session ready
                </div>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-[#444D5C]">
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
                      className="rounded-[6px] border border-[#D3D8DF] bg-[#F7F8F9] px-3 py-1.5 text-left text-[12.5px] text-[#444D5C] transition-colors hover:bg-[#DDE1E7] hover:text-[#161B26]"
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
                      <span className="text-[13px] font-bold text-[#161B26]">{msg.authorName}</span>
                      <span className="text-[12px] text-[#778091]">
                        {formatRelativeTime(msg.createdAt)}
                        {msg.modelInfo ? ` · ${msg.modelInfo}` : ''}
                        {msg.tokensPerSecond && msg.tokensPerSecond > 0
                          ? ` · ${msg.tokensPerSecond.toFixed(1)} tok/s`
                          : ''}
                      </span>
                    </div>

                    {msg.role === 'user' ? (
                      <div className="border-l-[3px] border-[#F2D452] py-0.5 pl-4 text-[15px] leading-relaxed whitespace-pre-wrap text-[#161B26]">
                        {msg.content}
                      </div>
                    ) : (
                      <div className="space-y-3 pt-0.5">
                        {hasThinking && (
                          <div className="rounded-[8px] border border-[#D3D8DF] bg-[#EEF0F3]/75">
                            <button
                              type="button"
                              aria-expanded={isThinkingExpanded}
                              data-testid={`thinking-toggle-${msg.id}`}
                              onClick={() =>
                                setExpandedThinkingIds((prev) => ({
                                  ...prev,
                                  [msg.id]: !prev[msg.id],
                                }))
                              }
                              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12.5px] font-medium text-[#444D5C] hover:text-[#161B26]"
                            >
                              <span className="inline-flex items-center gap-1.5">
                                {isThinkingExpanded ? (
                                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                                )}
                                <span className={isThinkingActive ? 'lowcon-streaming-glow font-semibold' : ''}>
                                  {thinkingLabel}
                                </span>
                              </span>
                              <span className="text-[11px] text-[#778091]">
                                {isThinkingExpanded ? 'Hide' : 'Show'}
                              </span>
                            </button>
                            {isThinkingExpanded && (
                              <div
                                data-testid={`thinking-content-${msg.id}`}
                                className="max-h-72 overflow-y-auto border-t border-[#D3D8DF] px-3 py-2.5"
                              >
                                <MarkdownMessage content={msg.thinkingContent ?? ''} compact />
                              </div>
                            )}
                          </div>
                        )}

                        {hasVisibleContent ? (
                          msg.isError ? (
                            <div className="rounded-[6px] border border-[#D9383A]/30 bg-[#D9383A]/5 px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-[#D9383A]">
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
                            className="rounded-[6px] border border-[#D3D8DF] bg-[#EEF0F3] px-3.5 py-2.5 text-[13px] text-[#444D5C]"
                          >
                            {msg.stopReason === 'max_tokens' && hasThinking
                              ? `Output reply reserve (${outputReserveTokens ?? 'current'} tokens) was reached during thinking before visible answer text started. Increase Output Reply Reserve in Settings or inspect the Thought process above.`
                              : 'Model finished without returning visible answer text.'}
                          </div>
                        )}

                        {msg.aside && (
                          <div className="border-l-[2px] border-[#AAB2BF] pl-3.5 text-[13px] italic text-[#444D5C]">
                            {msg.aside}
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
                              className="inline-flex items-center gap-1 rounded-[5px] px-2 py-1 text-[12px] text-[#778091] hover:bg-[#E8EBEF] hover:text-[#161B26]"
                            >
                              {copiedId === msg.id ? (
                                <Check className="h-3.5 w-3.5 text-[#1D7A4E]" />
                              ) : (
                                <Copy className="h-3.5 w-3.5" />
                              )}
                              <span>{copiedId === msg.id ? 'Copied' : 'Copy'}</span>
                            </button>

                            {msg.sources.length > 0 && (
                              <button
                                type="button"
                                onClick={() => onOpenSources(msg.sources)}
                                className="rounded-[5px] px-2 py-1 text-[12px] text-[#778091] hover:bg-[#E8EBEF] hover:text-[#161B26]"
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
                              className="rounded-[5px] px-2 py-1 text-[12px] text-[#778091] hover:bg-[#E8EBEF] hover:text-[#161B26]"
                            >
                              {savedNoteMsgId === msg.id ? 'Saved to Memory ✓' : 'Save as note'}
                            </button>
                          </div>
                        )}

                        {/* Per-Turn Context Strip */}
                        {msg.turnBudget && (
                          <div className="pt-2">
                            <div className="mb-1.5 flex items-center justify-between text-[12px]">
                              <span className="font-semibold text-[#161B26]">
                                Context used for this reply
                              </span>
                              <span className="text-[#778091] tabular-nums">
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
      <div className="shrink-0 px-6 pb-4 pt-2">
        <div className="mx-auto max-w-[660px] rounded-[12px] border border-[#161B26] bg-white px-4 py-3 shadow-xs">
          {attachedFile && (
            <div className="mb-2 flex items-center justify-between rounded-[6px] border border-[#D3D8DF] bg-[#EEF0F3] px-2.5 py-1 text-[12px] text-[#161B26]">
              <span className="truncate">
                Attached local file: <strong>{attachedFile.name}</strong> (
                {formatNumber(attachedFile.content.length)} chars)
              </span>
              <button
                type="button"
                onClick={() => onAttachFile(null)}
                aria-label="Remove attached file"
                className="ml-2 text-[#778091] hover:text-[#D9383A]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {fileError && (
            <div className="mb-2 text-[12px] text-[#D9383A]" role="alert">
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
            className="w-full resize-none border-0 bg-transparent text-[14.5px] leading-relaxed text-[#161B26] placeholder:text-[#778091] focus:outline-none"
          />

          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.json,.csv,.rs,.ts,.tsx,.js,.py"
                onChange={(e) => void handleFileChange(e)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[12.5px] text-[#444D5C] hover:bg-[#E8EBEF]"
              >
                <Paperclip className="h-3.5 w-3.5" />
                <span>Attach local file</span>
              </button>

              <button
                type="button"
                onClick={() => onToggleMemoryRetrieval(!memoryRetrievalEnabled)}
                aria-pressed={memoryRetrievalEnabled}
                className={`inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-[12.5px] font-medium hover:bg-[#E8EBEF] ${
                  memoryRetrievalEnabled ? 'text-[#2A3FE0]' : 'text-[#778091]'
                }`}
              >
                <Brain className="h-3.5 w-3.5" />
                <span>{memoryRetrievalEnabled ? 'Memory on' : 'Memory off'}</span>
              </button>

              <span className="hidden text-[11.5px] text-[#778091] sm:inline">
                Enter to send · Shift+Enter newline
              </span>
            </div>

            {isGenerating ? (
              <button
                type="button"
                onClick={onStopGeneration}
                className="inline-flex items-center gap-1.5 rounded-[8px] bg-[#D9383A] px-3.5 py-1.5 text-[13px] font-semibold text-white hover:bg-[#b82d2f]"
              >
                <Square className="h-3 w-3 fill-current" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onSendMessage}
                disabled={!composerText.trim()}
                className="rounded-[8px] bg-[#2A3FE0] px-4 py-1.5 text-[13px] font-semibold text-white transition-colors hover:bg-[#2234be] disabled:cursor-not-allowed disabled:opacity-45"
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
