import type { ModelOrigin } from './modelNames';

export type BackendType = 'mock' | 'lm_studio';

export type NavigationTab = 'chat' | 'models' | 'memory' | 'settings' | 'profile';

export type MessageRole = 'user' | 'assistant' | 'system';

export type ChatTemplateType = 'ChatML' | 'Llama3' | 'Llama2' | 'Mistral' | 'Gemma' | 'Raw';

export type DiagnosticLevel = 'disabled' | 'minimal_redacted' | 'debug_redacted';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh';

export type ChatWidthPreset = 'default' | 'medium' | 'wide' | 'fill';

export type PromptEffortPrompts = Record<EffortLevel, string>;

export type ContextSegmentKey =
  | 'core'
  | 'task'
  | 'mem'
  | 'recent'
  | 'tpl'
  | 'free'
  | 'out'
  | 'safe';

export type CandidateKind =
  | 'core_instruction'
  | 'current_user_message'
  | 'pinned_fact'
  | 'task_state'
  | 'retrieved_memory'
  | 'conversation_turn'
  | 'summary'
  | 'metadata'
  | 'template_overhead';

export interface ContextSegment {
  key: ContextSegmentKey;
  name: string;
  description: string;
  tokens: number;
  color: string;
  isHeld: boolean;
  isFree: boolean;
}

export interface BudgetPartition {
  modelLimit: number;
  promptBudget: number;
  outputReserve: number;
  safetyMargin: number;
}

export interface TurnContextBudget {
  totalLimit: number;
  segments: ContextSegment[];
}

export interface SectionTokenBreakdown {
  segmentKey: ContextSegmentKey;
  name: string;
  tokens: number;
  description: string;
}

export interface IncludedItem {
  id: string;
  kind: CandidateKind;
  label: string;
  tokens: number;
  sourceRef?: string;
}

export interface ExcludedCandidate {
  id: string;
  kind: CandidateKind;
  label: string;
  estimatedTokens: number;
  reason: string;
}

export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunctionDefinition;
}

export interface ToolCallRecord {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface GeneratedFileArtifact {
  id: string;
  filename: string;
  title: string;
  language: string;
  content: string;
  createdAt: number;
  updatedAt?: number;
  isEdited?: boolean;
}

export interface AttachedFileAttachment {
  name: string;
  content: string;
}

export type WorkspaceFileSource = 'upload' | 'chat' | 'ai';

export interface WorkspaceFile {
  id: string;
  filename: string;
  title: string;
  language: string;
  content: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  lockedByUser: boolean;
  source: WorkspaceFileSource;
}

export interface StructuredChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCallRecord[];
  tool_call_id?: string;
  name?: string;
}

export interface PromptInspection {
  exactRenderedPrompt: string;
  structuredMessages: StructuredChatMessage[];
  tools?: ToolDefinition[];
  totalTokens: number;
  isExactCount: boolean;
  tokenizerName: string;
  templateType: ChatTemplateType;
  budgetPartition: BudgetPartition;
  remainingCapacity: number;
  sections: SectionTokenBreakdown[];
  includedItems: IncludedItem[];
  excludedCandidates: ExcludedCandidate[];
  includedMemoryIds: string[];
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  authorName: string;
  createdAt: number;
  modelInfo?: string;
  content: string;
  thinkingContent?: string;
  thinkingDurationMs?: number;
  tokensPerSecond?: number;
  stopReason?: 'done' | 'max_tokens' | 'stop_sequence' | 'tool_calls';
  aside?: string;
  sources: string[];
  turnBudget?: TurnContextBudget;
  generatedFiles?: GeneratedFileArtifact[];
  attachedFiles?: AttachedFileAttachment[];
  toolActivity?: string[];
  isError?: boolean;
  tokenCount?: number;
}

export interface Session {
  id: string;
  title: string;
  subtitle: string;
  createdAt: number;
  updatedAt: number;
  taskGoal?: string;
  messages: ChatMessage[];
}

export interface MemoryNote {
  id: string;
  sessionId?: string;
  title: string;
  content: string;
  sourceReference: string;
  sourceMessageIds: string[];
  isPinned: boolean;
  isSummary: boolean;
  isDisabled: boolean;
  userApproved: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ModelProfile {
  id: string;
  name: string;
  filePath: string;
  backendType: BackendType;
  architecture: string;
  quantization: string;
  contextLimit: number;
  contextOverride?: number;
  chatTemplate: ChatTemplateType;
  fileSizeBytes: number;
  tensorCount?: number;
  ramFootprintMb?: number;
}

export type ThemePresetId = 'white' | 'gray' | 'black' | 'custom';

export interface ThemeSettings {
  preset: ThemePresetId;
  bg: string;
  surface: string;
  sidebar: string;
  accent: string;
}

export interface UserProfileSettings {
  username: string;
  customSystemPrompt: string;
}

export interface TokenUsageHistory {
  totalLifetimeTokens: number;
  dailyTokens: Record<string, number>;
}

export interface AppSettings {
  outputReservePct: number;
  safetyMarginPct: number;
  contextLimitOverride: number;
  memoryRetrievalEnabled: boolean;
  diagnosticLevel: DiagnosticLevel;
  lmStudioEndpoint: string;
  activeBackendType: BackendType;
  connectedLmModels: string[];
  selectedLmModel: string;
  modelDisplayAliases?: Record<string, string>;
  modelIconOverrides?: Record<string, ModelOrigin>;
  allowAiFileEdits: boolean;
  connectionStatus: string;
  storageNamespace: string;
  theme?: ThemeSettings;
  chatWidth?: ChatWidthPreset;
  effortLevel: EffortLevel;
  promptEffortEnabled: boolean;
  promptEffortPrompts: PromptEffortPrompts;
  userProfile?: UserProfileSettings;
}

export type WorkerStatus =
  | { state: 'unloaded' }
  | { state: 'loading'; modelId: string; modelName: string }
  | { state: 'loaded'; modelId: string; modelName: string; backend: BackendType; contextLimit: number }
  | { state: 'generating'; modelId: string; modelName: string; sessionId: string }
  | { state: 'error'; message: string };

export interface DiagnosticEntry {
  id: string;
  timestamp: number;
  level: 'INFO' | 'WARN' | 'ERROR';
  module: string;
  message: string;
}

export interface PersistedWorkspace {
  version: number;
  sessions: Session[];
  activeSessionId: string;
  models: ModelProfile[];
  activeModelId: string;
  memoryNotes: MemoryNote[];
  workspaceFiles: WorkspaceFile[];
  settings: AppSettings;
  tokenUsage?: TokenUsageHistory;
}

export const THEME_COLORS = {
  ink: '#161B26',
  ink2: '#444D5C',
  mute: '#778091',
  line: '#D3D8DF',
  bg: '#F7F8F9',
  side: '#E8EBEF',
  panel: '#EEF0F3',
  blue: '#2A3FE0',
  blue2: '#8F9CF3',
  hl: '#F2D452',
  grey: '#AAB2BF',
  green: '#1D7A4E',
  white: '#FFFFFF',
  hover: '#DDE1E7',
  hold: '#C6CCD6',
  danger: '#D9383A',
  segFree: '#EAEEF2',
} as const;

export function getEffectiveContextLimit(
  model: ModelProfile | undefined,
  globalOverride: number,
): number {
  if (!model) return Math.max(256, globalOverride);
  const modelLimit = model.contextOverride ?? model.contextLimit;
  return Math.max(256, Math.min(modelLimit, globalOverride));
}
