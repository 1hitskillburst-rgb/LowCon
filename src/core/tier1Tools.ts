import { retrieveMemoryNotes } from './memory';
import { safeTruncateChars } from './privacy';
import {
  buildToolPolicyInstruction,
  countLines,
  CREATE_FILE_TOOL_DEFINITION,
  CREATE_FILE_TOOL_NAME,
  parseToolArgumentsJson,
  TOOL_CALL_POLICY_INSTRUCTION,
} from './tools';
import type {
  AttachedFileAttachment,
  GeneratedFileArtifact,
  MemoryNote,
  ToolDefinition,
  WorkspaceFile,
} from './types';
import { upsertWorkspaceFile } from './workspaceFiles';

export const CALCULATE_TOOL_NAME = 'calculate';
export const EDIT_FILE_TOOL_NAME = 'edit_file';
export const READ_ATTACHED_CHUNK_TOOL_NAME = 'read_attached_chunk';
export const SEARCH_MEMORY_TOOL_NAME = 'search_memory';
export const SAVE_MEMORY_TOOL_NAME = 'save_memory_note';
export const SAVE_WORKSPACE_FILE_TOOL_NAME = 'save_workspace_file';

export const MAX_ATTACHED_CHUNK_LINES = 120;
export const ATTACHED_FILE_INDEX_LINE_THRESHOLD = 80;
export const ATTACHED_FILE_INDEX_CHAR_THRESHOLD = 2500;
const MAX_SEARCH_MEMORY_LIMIT = 8;
const DEFAULT_SEARCH_MEMORY_LIMIT = 5;
const MAX_MATH_EXPRESSION_LENGTH = 2000;
const MAX_MATH_NESTING_DEPTH = 64;
const MAX_REGEX_MATCHES = 100;
const MAX_DIFF_PREVIEW_LINES = 24;
const MAX_DIFF_PREVIEW_CHARS = 1200;
const MAX_SAVED_NOTE_CONTENT_CHARS = 800;

export type CalculateMode = 'math' | 'json_validate' | 'regex_test' | 'date_diff';

export type AttachedFileInput = AttachedFileAttachment;

export type CalculateToolResult =
  | {
      ok: true;
      status: 'ok';
      mode: CalculateMode;
      result: unknown;
      formatted: string;
      toolResultJson: string;
    }
  | {
      ok: false;
      status: 'error';
      mode: CalculateMode;
      error: string;
      toolResultJson: string;
    };

export type EditFileToolResult =
  | {
      ok: true;
      artifact: GeneratedFileArtifact;
      linesChanged: number;
      totalLines: number;
      previewDiff: string;
      toolResultJson: string;
    }
  | {
      ok: false;
      error: string;
      toolResultJson: string;
    };

export type ReadAttachedChunkToolResult =
  | {
      ok: true;
      filename: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      linesReturned: number;
      hasMore: boolean;
      capped: boolean;
      content: string;
      toolResultJson: string;
    }
  | {
      ok: false;
      error: string;
      toolResultJson: string;
    };

export interface MemorySearchHitExcerpt {
  id: string;
  title: string;
  content: string;
  sourceReference: string;
  isPinned: boolean;
  score: number;
}

export type SearchMemoryToolResult =
  | {
      ok: true;
      results: MemorySearchHitExcerpt[];
      count: number;
      toolResultJson: string;
    }
  | {
      ok: false;
      error: string;
      toolResultJson: string;
    };

export interface SaveMemoryNoteOptions {
  userApproved?: boolean;
  nowMs?: number;
}

export type SaveMemoryNoteToolResult =
  | {
      ok: true;
      note: MemoryNote;
      toolResultJson: string;
    }
  | {
      ok: false;
      error: string;
      toolResultJson: string;
    };

export interface SaveWorkspaceFileOptions {
  allowAiFileEdits?: boolean;
  nowMs?: number;
}

export type SaveWorkspaceFileToolResult =
  | {
      ok: true;
      file: WorkspaceFile;
      files: WorkspaceFile[];
      action: 'created' | 'updated';
      toolResultJson: string;
    }
  | {
      ok: false;
      error: string;
      toolResultJson: string;
    };

export const CALCULATE_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: CALCULATE_TOOL_NAME,
    description: 'Run deterministic math, JSON validation, regex test, or date_diff.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['math', 'json_validate', 'regex_test', 'date_diff'],
        },
        expression: { type: 'string' },
        input: { type: 'string' },
        pattern: { type: 'string' },
        flags: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
};

export const EDIT_FILE_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: EDIT_FILE_TOOL_NAME,
    description:
      'Patch an existing file (attached, Files-tab, or generated). Preferred: {filename, old_text, new_text} (never include "12: " line-number prefixes from read_attached_chunk). Also supports {filename, start_line, end_line, replacement}, multiple edits in edits[], or full-file {filename, content}.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              start_line: { type: 'integer', minimum: 1 },
              end_line: { type: 'integer', minimum: 1 },
              replacement: { type: 'string' },
              old_text: { type: 'string' },
              new_text: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
          },
        },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
        replacement: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['filename'],
    },
  },
};

export const READ_ATTACHED_CHUNK_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: READ_ATTACHED_CHUNK_TOOL_NAME,
    description: `Read 1-indexed lines (max ${MAX_ATTACHED_CHUNK_LINES}) from an attached, persistent Files-tab, or generated session file (inspect a file before calling edit_file).`,
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  },
};

export const SEARCH_MEMORY_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: SEARCH_MEMORY_TOOL_NAME,
    description: 'Search local memory notes and approved summaries.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_MEMORY_LIMIT },
        pinned_only: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

export const SAVE_MEMORY_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: SAVE_MEMORY_TOOL_NAME,
    description: 'Save a concise durable fact, preference, or rule to local memory.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        is_pinned: { type: 'boolean' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
  },
};

export const SAVE_WORKSPACE_FILE_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: SAVE_WORKSPACE_FILE_TOOL_NAME,
    description:
      'Store a file in the persistent Files tab so any future chat can reference or edit it without re-uploading. Provide content, or omit content to save an existing session attachment/generated file by filename.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string' },
        content: { type: 'string' },
        title: { type: 'string' },
        language: { type: 'string' },
      },
      required: ['filename'],
      additionalProperties: false,
    },
  },
};

export const TIER1_TOOL_DEFINITIONS: ToolDefinition[] = [
  CALCULATE_TOOL_DEFINITION,
  EDIT_FILE_TOOL_DEFINITION,
  READ_ATTACHED_CHUNK_TOOL_DEFINITION,
  SEARCH_MEMORY_TOOL_DEFINITION,
  SAVE_MEMORY_TOOL_DEFINITION,
];

export const ALL_FILE_AND_TIER1_TOOLS: ToolDefinition[] = [
  CREATE_FILE_TOOL_DEFINITION,
  ...TIER1_TOOL_DEFINITIONS,
];

export const ALL_WORKSPACE_TOOLS: ToolDefinition[] = [
  ...ALL_FILE_AND_TIER1_TOOLS,
  SAVE_WORKSPACE_FILE_TOOL_DEFINITION,
];

export const TIER1_TOOL_POLICY_INSTRUCTION = `[Tier 1 Tools]
- \`${CALCULATE_TOOL_NAME}\`: Exact math, json_validate, regex_test, or date_diff.
- \`${EDIT_FILE_TOOL_NAME}\`: Patch existing session or Files-tab files (inspect lines with \`${READ_ATTACHED_CHUNK_TOOL_NAME}\` first if needed); never echo the full file.
- \`${READ_ATTACHED_CHUNK_TOOL_NAME}\`: Read attached, Files-tab, or generated session files in <=${MAX_ATTACHED_CHUNK_LINES}-line chunks.
- \`${SEARCH_MEMORY_TOOL_NAME}\` / \`${SAVE_MEMORY_TOOL_NAME}\`: Recall prior facts or save durable rules/decisions.`;

export const FULL_TOOL_CALL_POLICY_INSTRUCTION = buildToolPolicyInstruction(
  TIER1_TOOL_POLICY_INSTRUCTION,
);

const TIER1_POLICY_BULLETS: Record<string, string> = {
  [CALCULATE_TOOL_NAME]: `- \`${CALCULATE_TOOL_NAME}\`: Exact math, json_validate, regex_test, or date_diff.`,
  [EDIT_FILE_TOOL_NAME]: `- \`${EDIT_FILE_TOOL_NAME}\`: Patch existing session or Files-tab files (inspect with \`${READ_ATTACHED_CHUNK_TOOL_NAME}\` first if needed); never echo the full file.`,
  [READ_ATTACHED_CHUNK_TOOL_NAME]: `- \`${READ_ATTACHED_CHUNK_TOOL_NAME}\`: Read attached, Files-tab, or generated session files in <=${MAX_ATTACHED_CHUNK_LINES}-line chunks.`,
  [SEARCH_MEMORY_TOOL_NAME]: `- \`${SEARCH_MEMORY_TOOL_NAME}\`: Search saved local memory notes.`,
  [SAVE_MEMORY_TOOL_NAME]: `- \`${SAVE_MEMORY_TOOL_NAME}\`: Save durable facts, preferences, or rules.`,
  [SAVE_WORKSPACE_FILE_TOOL_NAME]: `- \`${SAVE_WORKSPACE_FILE_TOOL_NAME}\`: Remember/store a file in the persistent Files tab across chats (omit content to copy an existing session file).`,
};

export function buildToolPolicyForTools(tools: ToolDefinition[]): string {
  if (tools.length === 0) return '';
  const names = new Set(tools.map((t) => t.function.name));
  const sections: string[] = [];
  if (names.has(CREATE_FILE_TOOL_NAME)) {
    sections.push(TOOL_CALL_POLICY_INSTRUCTION);
  }
  const tier1Bullets = Object.entries(TIER1_POLICY_BULLETS)
    .filter(([name]) => names.has(name))
    .map(([, bullet]) => bullet);
  if (tier1Bullets.length > 0) {
    sections.push(`[Tier 1 Tools]\n${tier1Bullets.join('\n')}`);
  }
  return sections.join('\n\n');
}

export function selectToolsForPromptBudget(
  modelContextLimit: number,
  options: {
    hasAttachments: boolean;
    hasGeneratedFiles: boolean;
    hasWorkspaceFiles?: boolean;
    includeWorkspaceFileTool?: boolean;
    allowAiFileEdits?: boolean;
  } = {
    hasAttachments: false,
    hasGeneratedFiles: false,
  },
): ToolDefinition[] {
  const allowEdits = options.allowAiFileEdits !== false;
  const filterEditable = (list: ToolDefinition[]) =>
    allowEdits ? list : list.filter((t) => t.function.name !== EDIT_FILE_TOOL_NAME);

  if (modelContextLimit >= 4096) {
    const base = options.includeWorkspaceFileTool ? ALL_WORKSPACE_TOOLS : ALL_FILE_AND_TIER1_TOOLS;
    return filterEditable(base);
  }
  if (modelContextLimit < 1536) {
    return [];
  }
  // On ultra-low ~2K context windows, keep a lean contextual tool subset so
  // pinned notes + indexed attachments + active tools always fit inside promptBudget.
  const hasReadable = options.hasAttachments || Boolean(options.hasWorkspaceFiles);
  const hasEditable =
    options.hasAttachments || options.hasGeneratedFiles || Boolean(options.hasWorkspaceFiles);
  if (hasReadable && hasEditable) {
    return filterEditable([READ_ATTACHED_CHUNK_TOOL_DEFINITION, EDIT_FILE_TOOL_DEFINITION]);
  }
  if (hasReadable) {
    return filterEditable([
      READ_ATTACHED_CHUNK_TOOL_DEFINITION,
      CALCULATE_TOOL_DEFINITION,
      CREATE_FILE_TOOL_DEFINITION,
    ]);
  }
  if (hasEditable) {
    return filterEditable([EDIT_FILE_TOOL_DEFINITION, CALCULATE_TOOL_DEFINITION]);
  }
  const defaults2k: ToolDefinition[] = [
    CREATE_FILE_TOOL_DEFINITION,
    CALCULATE_TOOL_DEFINITION,
    SEARCH_MEMORY_TOOL_DEFINITION,
  ];
  if (options.includeWorkspaceFileTool) {
    defaults2k.push(SAVE_WORKSPACE_FILE_TOOL_DEFINITION);
  }
  return filterEditable(defaults2k);
}

export function getToolPendingActivityLabel(toolName: string): string {
  switch (toolName) {
    case CREATE_FILE_TOOL_NAME:
      return 'Writing file...';
    case EDIT_FILE_TOOL_NAME:
      return 'Editing file...';
    case CALCULATE_TOOL_NAME:
      return 'Calculating...';
    case READ_ATTACHED_CHUNK_TOOL_NAME:
      return 'Reading file...';
    case SEARCH_MEMORY_TOOL_NAME:
      return 'Searching local memory...';
    case SAVE_MEMORY_TOOL_NAME:
      return 'Saving memory note...';
    case SAVE_WORKSPACE_FILE_TOOL_NAME:
      return 'Saving to Files tab...';
    default:
      return `Running ${toolName}...`;
  }
}

export function shouldIndexAttachedFile(content: string): boolean {
  return (
    countLines(content) > ATTACHED_FILE_INDEX_LINE_THRESHOLD ||
    content.length > ATTACHED_FILE_INDEX_CHAR_THRESHOLD
  );
}

export function formatAttachedFileForPrompt(file: AttachedFileInput): {
  promptBlock: string;
  isIndexed: boolean;
} {
  if (shouldIndexAttachedFile(file.content)) {
    return {
      isIndexed: true,
      promptBlock: `[Attached local file index — use ${READ_ATTACHED_CHUNK_TOOL_NAME} to read line ranges]\n${buildAttachedFileIndex(file.name, file.content)}`,
    };
  }
  return {
    isIndexed: false,
    promptBlock: `[Attached local file: ${file.name}]\n${file.content}`,
  };
}

// ---------------------------------------------------------------------------
// 1. Safe deterministic `calculate` evaluator (pure recursive-descent parser)
// ---------------------------------------------------------------------------

type MathToken =
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '%' | '**' | '^' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' };

function tokenizeMathExpression(input: string): MathToken[] {
  const tokens: MathToken[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if ((ch >= '0' && ch <= '9') || ch === '.') {
      const slice = input.slice(i);
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(slice);
      if (!match) {
        throw new Error(`Invalid number literal near '${slice.slice(0, 12)}'.`);
      }
      const num = Number(match[0]);
      if (!Number.isFinite(num)) {
        throw new Error(`Numeric literal '${match[0]}' is out of range.`);
      }
      tokens.push({ type: 'number', value: num });
      i += match[0].length;
      continue;
    }

    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const slice = input.slice(i);
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(slice);
      if (!match) {
        throw new Error(`Invalid identifier near '${slice.slice(0, 12)}'.`);
      }
      tokens.push({ type: 'ident', value: match[0] });
      i += match[0].length;
      continue;
    }

    if (ch === '*' && input[i + 1] === '*') {
      tokens.push({ type: 'op', value: '**' });
      i += 2;
      continue;
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%' || ch === '^') {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }

    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }

    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i += 1;
      continue;
    }

    throw new Error(`Unsupported character '${ch}' in math expression.`);
  }

  return tokens;
}

function assertFiniteResult(value: number, context: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${context} resulted in a non-finite number.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function evaluateMathFunction(name: string, args: number[]): number {
  const fn = name.toLowerCase();

  const requireArity = (expected: number): void => {
    if (args.length !== expected) {
      throw new Error(`Function '${fn}' expects ${expected} argument(s), got ${args.length}.`);
    }
  };

  switch (fn) {
    case 'sqrt': {
      requireArity(1);
      if (args[0] < 0) {
        throw new Error('sqrt requires a non-negative argument.');
      }
      return assertFiniteResult(Math.sqrt(args[0]), 'sqrt');
    }
    case 'abs':
      requireArity(1);
      return assertFiniteResult(Math.abs(args[0]), 'abs');
    case 'round': {
      if (args.length < 1 || args.length > 2) {
        throw new Error(`Function 'round' expects 1 or 2 arguments, got ${args.length}.`);
      }
      if (args.length === 1) {
        return assertFiniteResult(Math.round(args[0]), 'round');
      }
      const digits = args[1];
      if (!Number.isInteger(digits) || digits < 0 || digits > 15) {
        throw new Error('round second argument (digits) must be an integer between 0 and 15.');
      }
      const factor = Math.pow(10, digits);
      return assertFiniteResult(Math.round(args[0] * factor) / factor, 'round');
    }
    case 'floor':
      requireArity(1);
      return assertFiniteResult(Math.floor(args[0]), 'floor');
    case 'ceil':
      requireArity(1);
      return assertFiniteResult(Math.ceil(args[0]), 'ceil');
    case 'min':
      if (args.length < 1) {
        throw new Error('Function "min" requires at least 1 argument.');
      }
      return assertFiniteResult(Math.min(...args), 'min');
    case 'max':
      if (args.length < 1) {
        throw new Error('Function "max" requires at least 1 argument.');
      }
      return assertFiniteResult(Math.max(...args), 'max');
    case 'pow':
      requireArity(2);
      return assertFiniteResult(Math.pow(args[0], args[1]), 'pow');
    case 'log': {
      if (args.length < 1 || args.length > 2) {
        throw new Error(`Function 'log' expects 1 or 2 arguments, got ${args.length}.`);
      }
      if (args[0] <= 0) {
        throw new Error('log requires a positive argument.');
      }
      if (args.length === 1) {
        return assertFiniteResult(Math.log10(args[0]), 'log');
      }
      const base = args[1];
      if (base <= 0 || base === 1) {
        throw new Error('log base must be positive and not equal to 1.');
      }
      return assertFiniteResult(Math.log(args[0]) / Math.log(base), 'log');
    }
    case 'ln': {
      requireArity(1);
      if (args[0] <= 0) {
        throw new Error('ln requires a positive argument.');
      }
      return assertFiniteResult(Math.log(args[0]), 'ln');
    }
    case 'sin':
      requireArity(1);
      return assertFiniteResult(Math.sin(args[0]), 'sin');
    case 'cos':
      requireArity(1);
      return assertFiniteResult(Math.cos(args[0]), 'cos');
    case 'tan':
      requireArity(1);
      return assertFiniteResult(Math.tan(args[0]), 'tan');
    default:
      throw new Error(`Unknown function '${name}'.`);
  }
}

class MathParser {
  private readonly tokens: MathToken[];
  private pos = 0;
  private depth = 0;

  constructor(tokens: MathToken[]) {
    this.tokens = tokens;
  }

  private peek(): MathToken | undefined {
    return this.tokens[this.pos];
  }

  private consume(): MathToken | undefined {
    const tok = this.tokens[this.pos];
    this.pos += 1;
    return tok;
  }

  private enterDepth(): void {
    this.depth += 1;
    if (this.depth > MAX_MATH_NESTING_DEPTH) {
      throw new Error(`Expression exceeds maximum nesting depth (${MAX_MATH_NESTING_DEPTH}).`);
    }
  }

  private exitDepth(): void {
    this.depth -= 1;
  }

  parse(): number {
    if (this.tokens.length === 0) {
      throw new Error('Empty math expression.');
    }
    const value = this.parseAddSub();
    const trailing = this.peek();
    if (trailing) {
      throw new Error(`Unexpected token '${this.describeToken(trailing)}' in expression.`);
    }
    return assertFiniteResult(value, 'Calculation');
  }

  private describeToken(tok: MathToken): string {
    switch (tok.type) {
      case 'number':
        return String(tok.value);
      case 'ident':
        return tok.value;
      case 'op':
        return tok.value;
      case 'lparen':
        return '(';
      case 'rparen':
        return ')';
      case 'comma':
        return ',';
    }
  }

  private parseAddSub(): number {
    let left = this.parseMulDivMod();
    while (true) {
      const tok = this.peek();
      if (tok?.type === 'op' && (tok.value === '+' || tok.value === '-')) {
        this.consume();
        const right = this.parseMulDivMod();
        left = assertFiniteResult(tok.value === '+' ? left + right : left - right, 'Arithmetic');
      } else {
        break;
      }
    }
    return left;
  }

  private parseMulDivMod(): number {
    let left = this.parseUnary();
    while (true) {
      const tok = this.peek();
      if (tok?.type === 'op' && (tok.value === '*' || tok.value === '/' || tok.value === '%')) {
        this.consume();
        const right = this.parseUnary();
        if (tok.value === '*') {
          left = assertFiniteResult(left * right, 'Multiplication');
        } else if (tok.value === '/') {
          if (right === 0) {
            throw new Error('Division by zero.');
          }
          left = assertFiniteResult(left / right, 'Division');
        } else {
          if (right === 0) {
            throw new Error('Modulo by zero.');
          }
          left = assertFiniteResult(left % right, 'Modulo');
        }
      } else {
        break;
      }
    }
    return left;
  }

  private parseUnary(): number {
    const tok = this.peek();
    if (tok?.type === 'op' && (tok.value === '+' || tok.value === '-')) {
      this.consume();
      this.enterDepth();
      try {
        const operand = this.parseUnary();
        return assertFiniteResult(tok.value === '-' ? -operand : operand, 'Unary operation');
      } finally {
        this.exitDepth();
      }
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePrimary();
    const tok = this.peek();
    if (tok?.type === 'op' && (tok.value === '**' || tok.value === '^')) {
      this.consume();
      this.enterDepth();
      try {
        const exponent = this.parseUnary();
        return assertFiniteResult(Math.pow(base, exponent), 'Exponentiation');
      } finally {
        this.exitDepth();
      }
    }
    return base;
  }

  private parsePrimary(): number {
    const tok = this.peek();
    if (!tok) {
      throw new Error('Unexpected end of expression.');
    }

    if (tok.type === 'number') {
      this.consume();
      return tok.value;
    }

    if (tok.type === 'ident') {
      this.consume();
      if (this.peek()?.type === 'lparen') {
        this.consume();
        this.enterDepth();
        try {
          const fnArgs: number[] = [];
          if (this.peek()?.type !== 'rparen') {
            fnArgs.push(this.parseAddSub());
            while (this.peek()?.type === 'comma') {
              this.consume();
              fnArgs.push(this.parseAddSub());
            }
          }
          const closing = this.consume();
          if (closing?.type !== 'rparen') {
            throw new Error(`Expected ')' after arguments to '${tok.value}'.`);
          }
          return evaluateMathFunction(tok.value, fnArgs);
        } finally {
          this.exitDepth();
        }
      }

      const lower = tok.value.toLowerCase();
      if (lower === 'pi') return Math.PI;
      if (lower === 'e') return Math.E;
      throw new Error(`Unknown identifier '${tok.value}'.`);
    }

    if (tok.type === 'lparen') {
      this.consume();
      this.enterDepth();
      try {
        const inner = this.parseAddSub();
        const closing = this.consume();
        if (closing?.type !== 'rparen') {
          throw new Error("Expected closing ')'.");
        }
        return inner;
      } finally {
        this.exitDepth();
      }
    }

    throw new Error(`Unexpected token '${this.describeToken(tok)}' in expression.`);
  }
}

export function evaluateSafeMathExpression(expression: string): number {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error('calculate (mode="math") requires a non-empty "expression" string.');
  }
  if (trimmed.length > MAX_MATH_EXPRESSION_LENGTH) {
    throw new Error(`Math expression exceeds ${MAX_MATH_EXPRESSION_LENGTH} character limit.`);
  }
  const tokens = tokenizeMathExpression(trimmed);
  const parser = new MathParser(tokens);
  return parser.parse();
}

function formatCalculatedNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  const snapped = Number(value.toPrecision(14));
  if (Math.abs(value - snapped) <= 1e-13 * Math.max(1, Math.abs(value))) {
    return String(snapped);
  }
  return String(value);
}

function makeCalculateError(mode: CalculateMode, error: string): CalculateToolResult {
  return {
    ok: false,
    status: 'error',
    mode,
    error,
    toolResultJson: JSON.stringify({ status: 'error', error }),
  };
}

function makeCalculateSuccess(
  mode: CalculateMode,
  result: unknown,
  formatted: string,
): CalculateToolResult {
  return {
    ok: true,
    status: 'ok',
    mode,
    result,
    formatted,
    toolResultJson: JSON.stringify({ status: 'ok', result, formatted }),
  };
}

function parseStrictDateMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    const utcMs = Date.UTC(year, month - 1, day);
    const check = new Date(utcMs);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      return null;
    }
    return utcMs;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

export function detectUnsafeRegexPattern(pattern: string): string | null {
  const MAX_QUANTIFIERS = 30;
  let quantifierCount = 0;
  let inCharClass = false;
  let escaped = false;

  interface GroupFrame {
    startIdx: number;
    hasQuantifier: boolean;
    hasAlternation: boolean;
    hasBackref: boolean;
    branches: string[];
    currentBranchStart: number;
  }

  const stack: GroupFrame[] = [];

  const readQuantifierAt = (idx: number): { endIdx: number; isRepeating: boolean } | null => {
    const c = pattern[idx];
    if (c === '*' || c === '+') {
      const next = pattern[idx + 1] === '?' ? idx + 2 : idx + 1;
      return { endIdx: next, isRepeating: true };
    }
    if (c === '?') {
      const next = pattern[idx + 1] === '?' ? idx + 2 : idx + 1;
      return { endIdx: next, isRepeating: false };
    }
    if (c === '{') {
      const match = /^\{(\d+)(?:,(\d*))?\}\??/.exec(pattern.slice(idx));
      if (match) {
        const min = Number(match[1]);
        const hasComma = match[0].includes(',');
        const maxStr = match[2];
        const max = !hasComma ? min : maxStr === '' ? Infinity : Number(maxStr);
        return { endIdx: idx + match[0].length, isRepeating: max > 1 };
      }
    }
    return null;
  };

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (!inCharClass && next && next >= '1' && next <= '9' && stack.length > 0) {
        stack[stack.length - 1].hasBackref = true;
      }
      escaped = true;
      continue;
    }
    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      continue;
    }
    if (ch === '(') {
      let bodyStart = i + 1;
      if (pattern[bodyStart] === '?') {
        if (
          pattern.startsWith('?:', bodyStart) ||
          pattern.startsWith('?=', bodyStart) ||
          pattern.startsWith('?!', bodyStart)
        ) {
          bodyStart += 2;
        } else if (
          pattern.startsWith('?<=', bodyStart) ||
          pattern.startsWith('?<!', bodyStart)
        ) {
          bodyStart += 3;
        } else if (pattern[bodyStart + 1] === '<') {
          const closeName = pattern.indexOf('>', bodyStart + 2);
          if (closeName !== -1) bodyStart = closeName + 1;
        }
      }
      stack.push({
        startIdx: i,
        hasQuantifier: false,
        hasAlternation: false,
        hasBackref: false,
        branches: [],
        currentBranchStart: bodyStart,
      });
      continue;
    }
    if (ch === '|' && stack.length > 0) {
      const top = stack[stack.length - 1];
      top.hasAlternation = true;
      top.branches.push(pattern.slice(top.currentBranchStart, i));
      top.currentBranchStart = i + 1;
      continue;
    }
    if (ch === ')' && stack.length > 0) {
      const closed = stack.pop()!;
      closed.branches.push(pattern.slice(closed.currentBranchStart, i));
      const quant = readQuantifierAt(i + 1);
      if (quant) {
        quantifierCount += 1;
        if (quantifierCount > MAX_QUANTIFIERS) {
          return `Regex pattern exceeds maximum complexity (${MAX_QUANTIFIERS} quantifiers).`;
        }
        if (quant.isRepeating) {
          if (closed.hasQuantifier) {
            return 'Unsafe regex pattern rejected: nested quantifiers can cause catastrophic backtracking.';
          }
          if (closed.hasBackref) {
            return 'Unsafe regex pattern rejected: backreference inside a repeated group.';
          }
          if (closed.hasAlternation) {
            const normalized = closed.branches.map((b) => b.trim());
            const hasEmptyBranch = normalized.some((b) => b.length === 0);
            if (hasEmptyBranch) {
              return 'Unsafe regex pattern rejected: empty alternation inside a repeated group.';
            }
            for (let a = 0; a < normalized.length; a += 1) {
              for (let b = a + 1; b < normalized.length; b += 1) {
                const ba = normalized[a];
                const bb = normalized[b];
                if (
                  ba === bb ||
                  ba.startsWith(bb) ||
                  bb.startsWith(ba) ||
                  ba.includes('.') ||
                  bb.includes('.') ||
                  /\\[wdsWDS]/.test(ba) ||
                  /\\[wdsWDS]/.test(bb)
                ) {
                  return 'Unsafe regex pattern rejected: overlapping alternation inside a repeated group.';
                }
              }
            }
          }
        }
        if (stack.length > 0 && quant.isRepeating) {
          stack[stack.length - 1].hasQuantifier = true;
        }
        i = quant.endIdx - 1;
      } else if (stack.length > 0 && closed.hasQuantifier) {
        stack[stack.length - 1].hasQuantifier = true;
      }
      continue;
    }
    const quant = readQuantifierAt(i);
    if (quant) {
      quantifierCount += 1;
      if (quantifierCount > MAX_QUANTIFIERS) {
        return `Regex pattern exceeds maximum complexity (${MAX_QUANTIFIERS} quantifiers).`;
      }
      if (quant.isRepeating && stack.length > 0) {
        stack[stack.length - 1].hasQuantifier = true;
      }
      i = quant.endIdx - 1;
    }
  }

  return null;
}

export function executeCalculateTool(rawArguments: string): CalculateToolResult {
  const args = parseToolArgumentsJson(rawArguments);
  if (!args) {
    return makeCalculateError(
      'math',
      'Invalid JSON arguments for calculate. Provide an object with mode and parameters.',
    );
  }

  const rawMode = args.mode === undefined ? 'math' : args.mode;
  if (
    rawMode !== 'math' &&
    rawMode !== 'json_validate' &&
    rawMode !== 'regex_test' &&
    rawMode !== 'date_diff'
  ) {
    return makeCalculateError(
      'math',
      `Unsupported calculate mode '${String(rawMode)}'. Expected 'math', 'json_validate', 'regex_test', or 'date_diff'.`,
    );
  }

  if (rawMode === 'math') {
    const expr =
      typeof args.expression === 'string'
        ? args.expression
        : typeof args.expr === 'string'
          ? args.expr
          : '';
    if (!expr.trim()) {
      return makeCalculateError(
        'math',
        'calculate (mode="math") requires a non-empty "expression" string.',
      );
    }
    try {
      const value = evaluateSafeMathExpression(expr);
      return makeCalculateSuccess('math', value, formatCalculatedNumber(value));
    } catch (err) {
      return makeCalculateError('math', err instanceof Error ? err.message : String(err));
    }
  }

  if (rawMode === 'json_validate') {
    const rawJson =
      typeof args.input === 'string'
        ? args.input
        : typeof args.json === 'string'
          ? args.json
          : typeof args.expression === 'string'
            ? args.expression
            : null;
    if (rawJson === null) {
      return makeCalculateError(
        'json_validate',
        'calculate (mode="json_validate") requires a string "input" field.',
      );
    }
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      const valueType =
        parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
      const summary: Record<string, unknown> = {
        valid: true,
        type: valueType,
      };
      let formatted = `Valid JSON (${valueType})`;
      if (Array.isArray(parsed)) {
        summary.length = parsed.length;
        formatted = `Valid JSON array (${parsed.length} item${parsed.length === 1 ? '' : 's'})`;
      } else if (parsed !== null && typeof parsed === 'object') {
        const keys = Object.keys(parsed);
        summary.keyCount = keys.length;
        summary.keys = keys.slice(0, 25);
        formatted = `Valid JSON object (${keys.length} key${keys.length === 1 ? '' : 's'})`;
      }
      summary.parsed = parsed;
      return makeCalculateSuccess('json_validate', summary, formatted);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return makeCalculateError('json_validate', `Invalid JSON: ${msg}`);
    }
  }

  if (rawMode === 'regex_test') {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    const input =
      typeof args.input === 'string'
        ? args.input
        : typeof args.text === 'string'
          ? args.text
          : null;
    const flags = typeof args.flags === 'string' ? args.flags : '';

    if (!pattern || pattern.length > 500) {
      return makeCalculateError(
        'regex_test',
        'calculate (mode="regex_test") requires a non-empty "pattern" string (max 500 chars).',
      );
    }
    if (input === null || input.length > 20_000) {
      return makeCalculateError(
        'regex_test',
        'calculate (mode="regex_test") requires a string "input" field (max 20,000 chars).',
      );
    }
    if (args.flags !== undefined && typeof args.flags !== 'string') {
      return makeCalculateError('regex_test', 'Optional "flags" field must be a string.');
    }

    const unsafeReason = detectUnsafeRegexPattern(pattern);
    if (unsafeReason) {
      return makeCalculateError('regex_test', unsafeReason);
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return makeCalculateError('regex_test', `Invalid regular expression: ${msg}`);
    }

    const matches: Array<{ match: string; index: number; groups: string[] }> = [];
    let truncated = false;

    if (regex.global || regex.sticky) {
      let execResult: RegExpExecArray | null;
      while ((execResult = regex.exec(input)) !== null) {
        if (matches.length >= MAX_REGEX_MATCHES) {
          truncated = true;
          break;
        }
        matches.push({
          match: execResult[0],
          index: execResult.index,
          groups: execResult.slice(1).map((g) => g ?? ''),
        });
        if (execResult[0].length === 0) {
          if (regex.lastIndex >= input.length) break;
          regex.lastIndex += 1;
        }
      }
    } else {
      const single = regex.exec(input);
      if (single) {
        matches.push({
          match: single[0],
          index: single.index,
          groups: single.slice(1).map((g) => g ?? ''),
        });
      }
    }

    const result = {
      matched: matches.length > 0,
      count: matches.length,
      matches,
      truncated,
    };
    const formatted =
      matches.length === 0
        ? 'No matches'
        : `Matched ${matches.length} occurrence${matches.length === 1 ? '' : 's'}${truncated ? ` (truncated at ${MAX_REGEX_MATCHES})` : ''}`;

    return makeCalculateSuccess('regex_test', result, formatted);
  }

  // mode === 'date_diff'
  const startRaw =
    typeof args.start_date === 'string'
      ? args.start_date
      : typeof args.start === 'string'
        ? args.start
        : typeof args.from === 'string'
          ? args.from
          : '';
  const endRaw =
    typeof args.end_date === 'string'
      ? args.end_date
      : typeof args.end === 'string'
        ? args.end
        : typeof args.to === 'string'
          ? args.to
          : '';

  if (!startRaw.trim() || !endRaw.trim()) {
    return makeCalculateError(
      'date_diff',
      'calculate (mode="date_diff") requires non-empty "start_date" and "end_date" strings.',
    );
  }

  const startMs = parseStrictDateMs(startRaw);
  if (startMs === null) {
    return makeCalculateError('date_diff', `Invalid start_date '${startRaw}'. Use ISO-8601 format.`);
  }
  const endMs = parseStrictDateMs(endRaw);
  if (endMs === null) {
    return makeCalculateError('date_diff', `Invalid end_date '${endRaw}'. Use ISO-8601 format.`);
  }

  const diffMs = endMs - startMs;
  const seconds = diffMs / 1000;
  const minutes = diffMs / 60_000;
  const hours = diffMs / 3_600_000;
  const days = diffMs / 86_400_000;
  const direction = diffMs > 0 ? 'future' : diffMs < 0 ? 'past' : 'same';

  const result = {
    milliseconds: diffMs,
    seconds,
    minutes,
    hours,
    days,
    direction,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };

  let formatted: string;
  if (diffMs === 0) {
    formatted = '0 seconds (same timestamp)';
  } else if (Math.abs(days) >= 1) {
    formatted = `${formatCalculatedNumber(days)} days (${formatCalculatedNumber(hours)} hours)`;
  } else if (Math.abs(hours) >= 1) {
    formatted = `${formatCalculatedNumber(hours)} hours (${formatCalculatedNumber(minutes)} minutes)`;
  } else {
    formatted = `${formatCalculatedNumber(seconds)} seconds`;
  }

  return makeCalculateSuccess('date_diff', result, formatted);
}

// ---------------------------------------------------------------------------
// Shared file matching & line-splitting utilities
// ---------------------------------------------------------------------------

function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function getBasename(path: string): string {
  const norm = normalizeFilePath(path);
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

type MatchResolution<T> =
  | { ok: true; item: T }
  | { ok: false; error: string };

function resolveFileByName<T>(
  items: T[],
  requestedName: string | undefined,
  getName: (item: T) => string,
  emptyError: string,
  allowSingleDefault: boolean,
): MatchResolution<T> {
  if (items.length === 0) {
    return { ok: false, error: emptyError };
  }

  const availableNames = items.map(getName);
  const trimmed = requestedName?.trim() ?? '';

  if (!trimmed) {
    if (allowSingleDefault && items.length === 1) {
      return { ok: true, item: items[0] };
    }
    return {
      ok: false,
      error:
        items.length === 1
          ? `A non-empty "filename" is required. Available file: ${availableNames[0]}`
          : `Multiple files are available; specify "filename". Available files: ${availableNames.join(', ')}`,
    };
  }

  const normReq = normalizeFilePath(trimmed);
  const baseReq = getBasename(normReq);

  const pickUniqueOrLatestSameName = (candidates: T[]): MatchResolution<T> | null => {
    if (candidates.length === 0) return null;
    const distinctNames = new Set(candidates.map((c) => normalizeFilePath(getName(c))));
    if (distinctNames.size === 1) {
      return { ok: true, item: candidates[candidates.length - 1] };
    }
    return {
      ok: false,
      error: `Filename '${trimmed}' is ambiguous. Matching files: ${candidates.map(getName).join(', ')}`,
    };
  };

  // 1. Exact path match
  const exact = items.filter((item) => normalizeFilePath(getName(item)) === normReq);
  const exactPick = pickUniqueOrLatestSameName(exact);
  if (exactPick) return exactPick;

  // 2. Exact basename match
  const baseExact = items.filter((item) => getBasename(getName(item)) === baseReq);
  const basePick = pickUniqueOrLatestSameName(baseExact);
  if (basePick) return basePick;

  // 3. Case-insensitive path match
  const normReqLower = normReq.toLowerCase();
  const ciExact = items.filter(
    (item) => normalizeFilePath(getName(item)).toLowerCase() === normReqLower,
  );
  const ciExactPick = pickUniqueOrLatestSameName(ciExact);
  if (ciExactPick) return ciExactPick;

  // 4. Case-insensitive basename match
  const baseReqLower = baseReq.toLowerCase();
  const ciBase = items.filter((item) => getBasename(getName(item)).toLowerCase() === baseReqLower);
  const ciBasePick = pickUniqueOrLatestSameName(ciBase);
  if (ciBasePick) return ciBasePick;

  return {
    ok: false,
    error: `File '${trimmed}' not found. Available files: ${availableNames.join(', ')}`,
  };
}

function splitFileLines(content: string): {
  lines: string[];
  hasTrailingNewline: boolean;
  eol: '\r\n' | '\n';
} {
  if (!content) {
    return { lines: [], hasTrailingNewline: false, eol: '\n' };
  }
  const hasCrlf = content.includes('\r\n');
  const hasBareLf = content.replace(/\r\n/g, '').includes('\n');
  const eol: '\r\n' | '\n' = hasCrlf && !hasBareLf ? '\r\n' : '\n';
  const hasTrailingNewline = content.endsWith('\n');
  const raw = content.split(/\r?\n/);
  if (hasTrailingNewline) {
    raw.pop();
  }
  return { lines: raw, hasTrailingNewline, eol };
}

function joinFileLines(lines: string[], hasTrailingNewline: boolean, eol: '\r\n' | '\n'): string {
  if (lines.length === 0) {
    return '';
  }
  return lines.join(eol) + (hasTrailingNewline ? eol : '');
}

// ---------------------------------------------------------------------------
// 2. `edit_file` tool
// ---------------------------------------------------------------------------

interface LineRangeEditOp {
  kind: 'line_range';
  startLine: number;
  endLine: number;
  replacement: string;
}

interface ExactTextEditOp {
  kind: 'exact_text';
  oldText: string;
  newText: string;
  replaceAll: boolean;
  hintStartLine?: number;
  hintEndLine?: number;
}

interface FullContentEditOp {
  kind: 'full_content';
  content: string;
}

interface UnifiedPatchEditOp {
  kind: 'unified_patch';
  patch: string;
}

type ParsedEditOp =
  | LineRangeEditOp
  | ExactTextEditOp
  | FullContentEditOp
  | UnifiedPatchEditOp;

function parsePositiveIntLike(val: unknown): number | null {
  if (typeof val === 'number' && Number.isInteger(val) && val >= 1) {
    return val;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isSafeInteger(n) && n >= 1) {
        return n;
      }
    }
  }
  return null;
}

function parseBooleanLike(val: unknown): boolean | null {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return null;
}

function pickFirstStringField(
  rec: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: string } | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string') {
      return { key, value: v };
    }
  }
  return null;
}

function pickFirstNonEmptyStringField(
  rec: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: string } | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0) {
      return { key, value: v };
    }
  }
  return null;
}

function pickFirstDefinedField(
  rec: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: unknown } | null {
  for (const key of keys) {
    if (rec[key] !== undefined && rec[key] !== null) {
      return { key, value: rec[key] };
    }
  }
  return null;
}

const FILENAME_ALIAS_KEYS = [
  'filename',
  'file',
  'file_path',
  'filepath',
  'filePath',
  'path',
  'target_file',
  'targetFile',
  'name',
] as const;

const OLD_TEXT_ALIAS_KEYS = [
  'old_text',
  'old_string',
  'oldText',
  'oldString',
  'search',
  'find',
  'target',
  'original',
  'original_text',
  'before',
] as const;

const NEW_TEXT_ALIAS_KEYS = [
  'new_text',
  'new_string',
  'newText',
  'newString',
  'replace',
  'replace_with',
  'updated',
  'updated_text',
  'after',
] as const;

const REPLACEMENT_ALIAS_KEYS = ['replacement', 'text', 'code', 'new_content', 'content'] as const;

const START_LINE_ALIAS_KEYS = [
  'start_line',
  'startLine',
  'from_line',
  'fromLine',
  'line',
  'line_number',
  'lineNumber',
] as const;

const END_LINE_ALIAS_KEYS = ['end_line', 'endLine', 'to_line', 'toLine'] as const;

const REPLACE_ALL_ALIAS_KEYS = ['replace_all', 'replaceAll', 'all'] as const;

export function extractEditTargetFilename(args: Record<string, unknown> | null): string {
  if (!args) return '';
  const hit = pickFirstNonEmptyStringField(args, FILENAME_ALIAS_KEYS);
  return hit ? hit.value.trim() : '';
}

function parseSingleEditOp(raw: unknown, indexLabel: string): ParsedEditOp | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `${indexLabel} must be an object.`;
  }
  const rec = raw as Record<string, unknown>;

  const oldTextHit = pickFirstNonEmptyStringField(rec, OLD_TEXT_ALIAS_KEYS);
  const newTextHit = pickFirstStringField(rec, NEW_TEXT_ALIAS_KEYS);
  const replacementHit = pickFirstStringField(rec, REPLACEMENT_ALIAS_KEYS);
  const startLineField = pickFirstDefinedField(rec, START_LINE_ALIAS_KEYS);
  const endLineField = pickFirstDefinedField(rec, END_LINE_ALIAS_KEYS);
  const parsedStartLine = startLineField ? parsePositiveIntLike(startLineField.value) : null;
  const parsedEndLine = endLineField ? parsePositiveIntLike(endLineField.value) : null;

  // 1. Exact-text mode (preferred when old_text / alias is non-empty).
  // Tolerates null/empty/default line-range fields and uses start_line/end_line as
  // location hints to disambiguate multiple matches.
  if (oldTextHit) {
    const hasExplicitNewText = newTextHit !== null;
    const hasNonEmptyReplacement =
      replacementHit !== null &&
      replacementHit.key === 'replacement' &&
      replacementHit.value.length > 0;
    if (
      hasExplicitNewText &&
      hasNonEmptyReplacement &&
      newTextHit.value !== replacementHit.value
    ) {
      return `${indexLabel} has both "new_text" and "replacement". Pass ONLY {"old_text": "...", "new_text": "..."}.`;
    }
    const targetNewText = hasExplicitNewText
      ? newTextHit.value
      : replacementHit !== null
        ? replacementHit.value
        : null;
    if (targetNewText === null) {
      return `${indexLabel} requires a string "new_text" field alongside "old_text".`;
    }

    const replaceAllField = pickFirstDefinedField(rec, REPLACE_ALL_ALIAS_KEYS);
    let replaceAll = false;
    if (replaceAllField !== null) {
      const parsedBool = parseBooleanLike(replaceAllField.value);
      if (parsedBool === null) {
        return `${indexLabel} optional "replace_all" must be a boolean.`;
      }
      replaceAll = parsedBool;
    }

    return {
      kind: 'exact_text',
      oldText: oldTextHit.value,
      newText: targetNewText,
      replaceAll,
      ...(parsedStartLine ? { hintStartLine: parsedStartLine } : {}),
      ...(parsedEndLine ? { hintEndLine: parsedEndLine } : {}),
    };
  }

  // 2. Line-range mode (start_line provided and old_text is absent/empty)
  if (
    parsedStartLine !== null ||
    startLineField !== null ||
    endLineField !== null ||
    (replacementHit !== null && replacementHit.key === 'replacement' && replacementHit.value.length > 0)
  ) {
    if (
      newTextHit !== null &&
      newTextHit.value.length > 0 &&
      !(replacementHit !== null && replacementHit.value.length > 0) &&
      parsedStartLine === null
    ) {
      return `${indexLabel} provided "new_text" without a non-empty "old_text". Example: {"filename": "...", "old_text": "...", "new_text": "..."}.`;
    }
    if (parsedStartLine === null) {
      return `${indexLabel} requires a positive integer "start_line" (or non-empty "old_text" + "new_text").`;
    }
    let endLine = parsedStartLine;
    if (endLineField !== null) {
      if (parsedEndLine === null || parsedEndLine < parsedStartLine) {
        return `${indexLabel} "end_line" must be an integer >= start_line (${parsedStartLine}).`;
      }
      endLine = parsedEndLine;
    }
    const replacementStr =
      replacementHit !== null
        ? replacementHit.value
        : newTextHit !== null
          ? newTextHit.value
          : null;
    if (replacementStr === null) {
      return `${indexLabel} requires a string "replacement" field alongside "start_line".`;
    }
    return {
      kind: 'line_range',
      startLine: parsedStartLine,
      endLine,
      replacement: replacementStr,
    };
  }

  // 3. Unified diff / patch string fallback (e.g. { filename, patch: "@@ ... @@\n-old\n+new" })
  const patchHit = pickFirstNonEmptyStringField(rec, ['patch', 'diff', 'unified_diff']);
  if (patchHit) {
    return { kind: 'unified_patch', patch: patchHit.value };
  }

  // 4. Full-file content replacement fallback (e.g. { filename, content: "..." })
  const fullContentHit = pickFirstStringField(rec, ['content', 'new_content', 'full_content']);
  if (fullContentHit && indexLabel === 'edit_file') {
    return { kind: 'full_content', content: fullContentHit.value };
  }

  if (
    pickFirstDefinedField(rec, OLD_TEXT_ALIAS_KEYS) !== null ||
    pickFirstDefinedField(rec, NEW_TEXT_ALIAS_KEYS) !== null
  ) {
    return `${indexLabel} requires a non-empty string "old_text" and string "new_text". Example: {"old_text": "old", "new_text": "new"}.`;
  }

  return `${indexLabel} must specify {"old_text": "...", "new_text": "..."} OR {"start_line": 1, "end_line": 1, "replacement": "..."}.`;
}

function splitReplacementLines(replacement: string): string[] {
  if (replacement === '') {
    return [];
  }
  const normalized = replacement.replace(/\r\n/g, '\n');
  const trimmedSingleTrailing = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;
  return trimmedSingleTrailing.split('\n');
}

interface DiffLineOp {
  type: 'equal' | 'del' | 'add';
  oldLineNum?: number;
  newLineNum?: number;
  text: string;
}

function computeLineDiff(oldContent: string, newContent: string): {
  linesChanged: number;
  previewDiff: string;
} {
  const oldLines = splitFileLines(oldContent).lines;
  const newLines = splitFileLines(newContent).lines;

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);

  if (oldMid.length === 0 && newMid.length === 0) {
    return { linesChanged: 0, previewDiff: '(no changes)' };
  }

  const ops: DiffLineOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ type: 'equal', oldLineNum: i + 1, newLineNum: i + 1, text: oldLines[i] });
  }

  const m = oldMid.length;
  const n = newMid.length;

  if (m * n <= 40_000) {
    const dp = new Uint32Array((m + 1) * (n + 1));
    const cols = n + 1;
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (oldMid[i] === newMid[j]) {
          dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * cols + j];
          const right = dp[i * cols + (j + 1)];
          dp[i * cols + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (oldMid[i] === newMid[j]) {
        ops.push({
          type: 'equal',
          oldLineNum: prefix + i + 1,
          newLineNum: prefix + j + 1,
          text: oldMid[i],
        });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
        ops.push({ type: 'del', oldLineNum: prefix + i + 1, text: oldMid[i] });
        i += 1;
      } else {
        ops.push({ type: 'add', newLineNum: prefix + j + 1, text: newMid[j] });
        j += 1;
      }
    }
    while (i < m) {
      ops.push({ type: 'del', oldLineNum: prefix + i + 1, text: oldMid[i] });
      i += 1;
    }
    while (j < n) {
      ops.push({ type: 'add', newLineNum: prefix + j + 1, text: newMid[j] });
      j += 1;
    }
  } else {
    for (let i = 0; i < m; i++) {
      ops.push({ type: 'del', oldLineNum: prefix + i + 1, text: oldMid[i] });
    }
    for (let j = 0; j < n; j++) {
      ops.push({ type: 'add', newLineNum: prefix + j + 1, text: newMid[j] });
    }
  }

  for (let s = 0; s < suffix; s++) {
    const oi = oldLines.length - suffix + s;
    const ni = newLines.length - suffix + s;
    ops.push({ type: 'equal', oldLineNum: oi + 1, newLineNum: ni + 1, text: oldLines[oi] });
  }

  // Count linesChanged per contiguous change hunk: max(deleted, added)
  let linesChanged = 0;
  let hunkDel = 0;
  let hunkAdd = 0;
  for (const op of ops) {
    if (op.type === 'del') {
      hunkDel += 1;
    } else if (op.type === 'add') {
      hunkAdd += 1;
    } else {
      linesChanged += Math.max(hunkDel, hunkAdd);
      hunkDel = 0;
      hunkAdd = 0;
    }
  }
  linesChanged += Math.max(hunkDel, hunkAdd);

  // Build compact unified preview diff with 1 line of context around changes
  const previewLines: string[] = [];
  const includeIdx = new Set<number>();
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type !== 'equal') {
      if (idx > 0) includeIdx.add(idx - 1);
      includeIdx.add(idx);
      if (idx + 1 < ops.length) includeIdx.add(idx + 1);
    }
  }

  let prevIncluded = -2;
  let truncatedLines = 0;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!includeIdx.has(idx)) continue;
    const op = ops[idx];
    if (idx > prevIncluded + 1) {
      const lineRef = op.newLineNum ?? op.oldLineNum ?? 1;
      if (previewLines.length < MAX_DIFF_PREVIEW_LINES) {
        previewLines.push(`@@ L${lineRef} @@`);
      }
    }
    prevIncluded = idx;

    const prefixChar = op.type === 'del' ? '-' : op.type === 'add' ? '+' : ' ';
    const lineText = `${prefixChar} ${safeTruncateChars(op.text, 120)}`;
    if (previewLines.length < MAX_DIFF_PREVIEW_LINES) {
      previewLines.push(lineText);
    } else if (op.type !== 'equal') {
      truncatedLines += 1;
    }
  }

  if (truncatedLines > 0) {
    previewLines.push(`... (+${truncatedLines} more changed line(s))`);
  }

  const previewDiff = safeTruncateChars(previewLines.join('\n'), MAX_DIFF_PREVIEW_CHARS);
  return { linesChanged, previewDiff };
}

function makeEditFileError(error: string): EditFileToolResult {
  return {
    ok: false,
    error,
    toolResultJson: JSON.stringify({ status: 'error', error }),
  };
}

/**
 * Strips `read_attached_chunk` line-number prefixes like `12: code` or `  12: code`
 * when EVERY non-empty line in a block carries a plausible numeric prefix (sequential
 * for multi-line blocks, or matching a given expected start line).
 */
function stripReadChunkLineNumberPrefixes(
  text: string,
  expectedStartLine?: number,
): { stripped: string; didStrip: boolean; firstLineNum?: number } {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const nonEmptyEntries: Array<{ idx: number; lineNum: number; rest: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const m = /^\s*(\d+):\s?(.*)$/.exec(line);
    if (!m) {
      return { stripped: text, didStrip: false };
    }
    const lineNum = Number(m[1]);
    if (!Number.isSafeInteger(lineNum) || lineNum < 1) {
      return { stripped: text, didStrip: false };
    }
    nonEmptyEntries.push({ idx: i, lineNum, rest: m[2] });
  }

  if (nonEmptyEntries.length === 0) {
    return { stripped: text, didStrip: false };
  }

  const firstNum = nonEmptyEntries[0].lineNum;
  if (expectedStartLine !== undefined && firstNum !== expectedStartLine) {
    return { stripped: text, didStrip: false };
  }

  // For multi-line blocks, verify line numbers are strictly increasing and match line offsets
  if (nonEmptyEntries.length >= 2) {
    for (let k = 1; k < nonEmptyEntries.length; k++) {
      const prev = nonEmptyEntries[k - 1];
      const curr = nonEmptyEntries[k];
      if (curr.lineNum <= prev.lineNum || curr.lineNum - prev.lineNum > curr.idx - prev.idx + 1) {
        return { stripped: text, didStrip: false };
      }
    }
  } else if (expectedStartLine === undefined) {
    // Single line: only treat as a line-number prefix if it's clearly "12: ..." (not e.g. JSON/YAML `"12":` or `8080:`)
    if (!/^\s*\d+:\s/.test(lines[nonEmptyEntries[0].idx])) {
      return { stripped: text, didStrip: false };
    }
  }

  const outLines = [...lines];
  for (const entry of nonEmptyEntries) {
    outLines[entry.idx] = entry.rest;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return {
    stripped: outLines.join(eol),
    didStrip: true,
    firstLineNum: firstNum,
  };
}

interface TextMatchSpan {
  start: number;
  end: number;
  lineNumber: number; // 1-indexed
  indentDelta?: string;
  removeIndentCols?: number;
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function findExactSpans(haystack: string, needle: string): TextMatchSpan[] {
  const spans: TextMatchSpan[] = [];
  if (!needle) return spans;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    spans.push({
      start: idx,
      end: idx + needle.length,
      lineNumber: lineNumberAtOffset(haystack, idx),
    });
    pos = idx + needle.length;
  }
  return spans;
}

function computeLineOffsets(text: string): Array<{ start: number; end: number; raw: string }> {
  const result: Array<{ start: number; end: number; raw: string }> = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      const endWithoutNl = i > start && text[i - 1] === '\r' ? i - 1 : i;
      result.push({
        start,
        end: endWithoutNl,
        raw: text.slice(start, endWithoutNl),
      });
      start = i + 1;
    }
  }
  // Drop trailing synthetic empty entry when file ends with \n
  if (text.endsWith('\n') && result.length > 0 && result[result.length - 1].raw === '') {
    result.pop();
  }
  return result;
}

function getLeadingWhitespace(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m ? m[0] : '';
}

/**
 * Matches a multi-line (or single-line) needle against file lines with normalized
 * trailing whitespace or normalized leading indentation.
 */
function findLineNormalizedSpans(
  haystack: string,
  needle: string,
  mode: 'trim_end' | 'trim_both',
): TextMatchSpan[] {
  const needleNorm = needle.replace(/\r\n/g, '\n');
  const hadTrailingNl = needleNorm.endsWith('\n');
  const rawNeedleLines = (hadTrailingNl ? needleNorm.slice(0, -1) : needleNorm).split('\n');
  if (rawNeedleLines.length === 0) return [];

  const fileLines = computeLineOffsets(haystack);
  if (fileLines.length < rawNeedleLines.length) return [];

  const normFn = (s: string) =>
    mode === 'trim_end' ? s.replace(/[ \t]+$/, '') : s.trim();

  const normNeedle = rawNeedleLines.map(normFn);
  // Avoid matching purely blank lines in trim_both mode
  if (mode === 'trim_both' && normNeedle.every((l) => l === '')) {
    return [];
  }

  const spans: TextMatchSpan[] = [];
  const winLen = normNeedle.length;

  for (let i = 0; i <= fileLines.length - winLen; i++) {
    let matched = true;
    for (let j = 0; j < winLen; j++) {
      if (normFn(fileLines[i + j].raw) !== normNeedle[j]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const firstFileLine = fileLines[i];
    const lastFileLine = fileLines[i + winLen - 1];
    let endPos = lastFileLine.end;
    if (hadTrailingNl) {
      if (haystack.slice(endPos, endPos + 2) === '\r\n') endPos += 2;
      else if (haystack[endPos] === '\n') endPos += 1;
    }

    let indentDelta: string | undefined;
    let removeIndentCols: number | undefined;
    if (mode === 'trim_both') {
      // Compute indentation adjustment from the first non-empty line in the match
      const firstNonEmptyIdx = rawNeedleLines.findIndex((l) => l.trim().length > 0);
      if (firstNonEmptyIdx !== -1) {
        const needleIndent = getLeadingWhitespace(rawNeedleLines[firstNonEmptyIdx]);
        const fileIndent = getLeadingWhitespace(fileLines[i + firstNonEmptyIdx].raw);
        if (fileIndent.length > needleIndent.length && fileIndent.endsWith(needleIndent)) {
          indentDelta = fileIndent.slice(0, fileIndent.length - needleIndent.length);
        } else if (needleIndent.length > fileIndent.length && needleIndent.endsWith(fileIndent)) {
          removeIndentCols = needleIndent.length - fileIndent.length;
        } else if (fileIndent !== needleIndent) {
          // Different indent chars (e.g. tabs vs spaces): replace needleIndent prefix with fileIndent
          removeIndentCols = needleIndent.length;
          indentDelta = fileIndent;
        }
      }
    }

    spans.push({
      start: firstFileLine.start,
      end: endPos,
      lineNumber: i + 1,
      ...(indentDelta ? { indentDelta } : {}),
      ...(removeIndentCols ? { removeIndentCols } : {}),
    });
  }

  return spans;
}

function adjustReplacementIndentation(
  replacement: string,
  span: TextMatchSpan,
  eol: '\r\n' | '\n',
): string {
  const normalized = replacement.replace(/\r?\n/g, '\n');
  const adjusted =
    !span.indentDelta && !span.removeIndentCols
      ? normalized
      : normalized
          .split('\n')
          .map((line) => {
            if (line.trim() === '') return line;
            let next = line;
            if (span.removeIndentCols && span.removeIndentCols > 0) {
              const leading = getLeadingWhitespace(next);
              const cut = Math.min(leading.length, span.removeIndentCols);
              next = next.slice(cut);
            }
            if (span.indentDelta) {
              next = span.indentDelta + next;
            }
            return next;
          })
          .join('\n');
  return eol === '\r\n' ? adjusted.replace(/\n/g, '\r\n') : adjusted;
}

/**
 * Finds the closest matching line window in a file when `old_text` is not found,
 * returning a compact 1-indexed numbered preview so the LLM can self-correct on Round 2.
 */
function buildClosestMatchHint(content: string, oldText: string): string {
  const { lines } = splitFileLines(content);
  if (lines.length === 0) return ' (File is currently empty.)';

  const needleLines = oldText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tokens = new Set(
    needleLines
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 2),
  );

  let bestLineIdx = 0;
  let bestScore = -1;
  if (tokens.size > 0) {
    for (let i = 0; i < lines.length; i++) {
      const lowerLine = lines[i].toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (lowerLine.includes(tok)) score += tok.length;
      }
      // Bonus for exact trimmed first-line match
      if (needleLines[0] && lines[i].trim() === needleLines[0]) {
        score += 100;
      }
      if (score > bestScore) {
        bestScore = score;
        bestLineIdx = i;
      }
    }
  }

  const windowRadius = 3;
  const startIdx = bestScore > 0 ? Math.max(0, bestLineIdx - 1) : 0;
  const endIdx = Math.min(lines.length, startIdx + Math.max(6, needleLines.length + windowRadius));
  const snippet = lines
    .slice(startIdx, endIdx)
    .map((line, offset) => `${startIdx + offset + 1}: ${safeTruncateChars(line, 120)}`)
    .join('\n');

  return `\nClosest lines in file (do NOT include "N: " line-number prefixes in old_text):\n${snippet}`;
}

/**
 * Applies a simple unified diff patch (`@@ -oldStart,oldCount +newStart,newCount @@` or `-`/`+` hunk)
 * to file content.
 */
function applyUnifiedDiffPatch(
  content: string,
  rawPatch: string,
): { ok: true; content: string } | { ok: false; error: string } {
  const { lines, hasTrailingNewline, eol } = splitFileLines(content);
  const patchLines = rawPatch.replace(/\r\n/g, '\n').split('\n');

  interface Hunk {
    oldStart?: number;
    entries: Array<{ op: ' ' | '-' | '+'; text: string }>;
  }

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const rawLine of patchLines) {
    if (rawLine.startsWith('--- ') || rawLine.startsWith('+++ ') || rawLine.startsWith('diff ')) {
      continue;
    }
    const header = /^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/.exec(rawLine);
    if (header) {
      current = { oldStart: Number(header[1]), entries: [] };
      hunks.push(current);
      continue;
    }
    if (rawLine === '\\ No newline at end of file') {
      continue;
    }
    if (rawLine.startsWith('+') || rawLine.startsWith('-') || rawLine.startsWith(' ')) {
      if (!current) {
        current = { entries: [] };
        hunks.push(current);
      }
      current.entries.push({ op: rawLine[0] as ' ' | '-' | '+', text: rawLine.slice(1) });
    }
  }

  if (hunks.length === 0 || hunks.every((h) => h.entries.length === 0)) {
    return { ok: false, error: 'edit_file "patch" did not contain any valid unified diff hunks.' };
  }

  const working = [...lines];
  let lineOffset = 0;

  for (const hunk of hunks) {
    const expectedOld = hunk.entries.filter((e) => e.op !== '+').map((e) => e.text);
    const replacementNew = hunk.entries.filter((e) => e.op !== '-').map((e) => e.text);

    if (expectedOld.length === 0) {
      const insertAt = Math.min(
        working.length,
        Math.max(0, (hunk.oldStart ?? working.length + 1) - 1 + lineOffset),
      );
      working.splice(insertAt, 0, ...replacementNew);
      lineOffset += replacementNew.length;
      continue;
    }

    const findMatchAt = (strict: boolean): number => {
      const matches: number[] = [];
      for (let i = 0; i <= working.length - expectedOld.length; i++) {
        let ok = true;
        for (let j = 0; j < expectedOld.length; j++) {
          const a = strict ? working[i + j] : working[i + j].trim();
          const b = strict ? expectedOld[j] : expectedOld[j].trim();
          if (a !== b) {
            ok = false;
            break;
          }
        }
        if (ok) matches.push(i);
      }
      if (matches.length === 0) return -1;
      if (matches.length === 1) return matches[0];
      if (hunk.oldStart !== undefined) {
        const expectedIdx = Math.max(0, hunk.oldStart - 1 + lineOffset);
        matches.sort((a, b) => Math.abs(a - expectedIdx) - Math.abs(b - expectedIdx));
        return matches[0];
      }
      return -2; // ambiguous
    };

    let idx = findMatchAt(true);
    if (idx === -1) idx = findMatchAt(false);
    if (idx === -1) {
      return {
        ok: false,
        error: `Unified diff hunk did not match file content.${buildClosestMatchHint(
          joinFileLines(working, hasTrailingNewline, eol),
          expectedOld.join('\n'),
        )}`,
      };
    }
    if (idx === -2) {
      return {
        ok: false,
        error: 'Unified diff hunk matched multiple locations; add @@ line headers or more context.',
      };
    }

    working.splice(idx, expectedOld.length, ...replacementNew);
    lineOffset += replacementNew.length - expectedOld.length;
  }

  return {
    ok: true,
    content: joinFileLines(working, hasTrailingNewline, eol),
  };
}

export function executeEditFileTool(
  rawArguments: string,
  existingFiles: GeneratedFileArtifact[],
): EditFileToolResult {
  const args = parseToolArgumentsJson(rawArguments);
  if (!args) {
    return makeEditFileError(
      'Invalid JSON arguments for edit_file. Provide an object with filename and edit parameters.',
    );
  }

  const requestedFilename = extractEditTargetFilename(args);
  const match = resolveFileByName(
    existingFiles,
    requestedFilename || undefined,
    (f) => f.filename,
    'No editable files exist in this session yet. Attach a file, add one in the Files tab, or use create_file first.',
    true,
  );
  if (!match.ok) {
    return makeEditFileError(match.error);
  }

  const target = match.item;
  const parsedOps: ParsedEditOp[] = [];

  if (args.edits !== undefined && args.edits !== null) {
    let rawEdits: unknown = args.edits;
    // Recover stringified JSON array or single edit object passed in `edits`
    if (typeof rawEdits === 'string') {
      const trimmedEdits = rawEdits.trim();
      try {
        rawEdits = JSON.parse(trimmedEdits) as unknown;
      } catch {
        const recovered = parseToolArgumentsJson(trimmedEdits);
        if (recovered) {
          rawEdits = [recovered];
        }
      }
    } else if (rawEdits && typeof rawEdits === 'object' && !Array.isArray(rawEdits)) {
      rawEdits = [rawEdits];
    }

    if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
      return makeEditFileError('edit_file "edits" must be a non-empty array of edit operations.');
    }
    for (let i = 0; i < rawEdits.length; i++) {
      const op = parseSingleEditOp(rawEdits[i], `edits[${i}]`);
      if (typeof op === 'string') {
        return makeEditFileError(op);
      }
      parsedOps.push(op);
    }
  } else {
    const singleOp = parseSingleEditOp(args, 'edit_file');
    if (typeof singleOp === 'string') {
      return makeEditFileError(singleOp);
    }
    parsedOps.push(singleOp);
  }

  const lineOps = parsedOps.filter((op): op is LineRangeEditOp => op.kind === 'line_range');
  const textOps = parsedOps.filter((op): op is ExactTextEditOp => op.kind === 'exact_text');
  const fullOps = parsedOps.filter((op): op is FullContentEditOp => op.kind === 'full_content');
  const patchOps = parsedOps.filter((op): op is UnifiedPatchEditOp => op.kind === 'unified_patch');

  if (lineOps.length > 0 && textOps.length > 0) {
    return makeEditFileError(
      'edit_file cannot mix line-range edits and old_text/new_text edits in the same call.',
    );
  }

  let updatedContent = target.content;
  const targetEol: '\r\n' | '\n' =
    target.content.includes('\r\n') && !target.content.replace(/\r\n/g, '').includes('\n')
      ? '\r\n'
      : '\n';

  // Full-file replacement fallback
  if (fullOps.length > 0) {
    const nextRaw = fullOps[fullOps.length - 1].content;
    updatedContent = targetEol === '\r\n' ? nextRaw.replace(/\r?\n/g, '\r\n') : nextRaw;
  }

  // Unified diff patch fallback
  for (const op of patchOps) {
    const patched = applyUnifiedDiffPatch(updatedContent, op.patch);
    if (!patched.ok) {
      return makeEditFileError(patched.error);
    }
    updatedContent = patched.content;
  }

  // Apply line-range edits validated against original line bounds and applied bottom-to-top
  if (lineOps.length > 0) {
    const { lines, hasTrailingNewline, eol } = splitFileLines(updatedContent);
    const total = lines.length;

    const normalizedLineOps: LineRangeEditOp[] = [];
    for (const op of lineOps) {
      // Allow appending right after EOF (start_line === total + 1) or inserting into empty file (start_line === 1)
      if (total === 0) {
        if (op.startLine !== 1) {
          return makeEditFileError(
            `Line range ${op.startLine}-${op.endLine} is out of bounds for empty file '${target.filename}' (use start_line: 1).`,
          );
        }
        normalizedLineOps.push({ ...op, startLine: 1, endLine: 0 });
        continue;
      }

      if (op.startLine > total + 1) {
        return makeEditFileError(
          `Line range ${op.startLine}-${op.endLine} is out of bounds for '${target.filename}' (${total} lines).`,
        );
      }

      const clampedEnd = op.startLine === total + 1 ? total : Math.min(op.endLine, total);
      // Automatically strip accidental `read_attached_chunk` "12: " prefixes if they match startLine
      const prefixCheck = stripReadChunkLineNumberPrefixes(op.replacement, op.startLine);
      normalizedLineOps.push({
        ...op,
        endLine: clampedEnd,
        replacement: prefixCheck.didStrip ? prefixCheck.stripped : op.replacement,
      });
    }

    const sortedByStart = [...normalizedLineOps].sort((a, b) => a.startLine - b.startLine);
    for (let i = 1; i < sortedByStart.length; i++) {
      const prev = sortedByStart[i - 1];
      const curr = sortedByStart[i];
      if (curr.startLine <= prev.endLine) {
        return makeEditFileError(
          `Overlapping line-range edits: ${prev.startLine}-${prev.endLine} and ${curr.startLine}-${curr.endLine}.`,
        );
      }
    }

    const workingLines = [...lines];
    const descending = [...sortedByStart].reverse();
    for (const op of descending) {
      const replacementLines = splitReplacementLines(op.replacement);
      if (op.endLine < op.startLine) {
        // Pure insertion (empty file or append at total + 1)
        workingLines.splice(op.startLine - 1, 0, ...replacementLines);
      } else {
        workingLines.splice(op.startLine - 1, op.endLine - op.startLine + 1, ...replacementLines);
      }
    }

    updatedContent = joinFileLines(
      workingLines,
      hasTrailingNewline || (total === 0 && workingLines.length > 0 && target.content.endsWith('\n')),
      eol,
    );
  }

  // Apply exact-text edits sequentially with multi-tier local-LLM resilience:
  // 1. Exact match (with CRLF alignment)
  // 2. Strip accidental `read_attached_chunk` "12: " prefixes
  // 3. Trailing-whitespace normalized line match
  // 4. Indentation-agnostic trimmed line-block match (preserving file base indentation)
  for (const op of textOps) {
    const fileHasCrlf = updatedContent.includes('\r\n');
    const alignEol = (s: string) => (fileHasCrlf ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));

    let effectiveOld = op.oldText;
    let effectiveNew = op.newText;

    // Tier 1: Exact substring match (raw, then EOL-aligned)
    let spans = findExactSpans(updatedContent, effectiveOld);
    if (spans.length === 0) {
      const eolOld = alignEol(effectiveOld);
      if (eolOld !== effectiveOld) {
        const eolSpans = findExactSpans(updatedContent, eolOld);
        if (eolSpans.length > 0) {
          spans = eolSpans;
          effectiveOld = eolOld;
          effectiveNew = alignEol(effectiveNew);
        }
      }
    }

    // Tier 2: Strip accidental `read_attached_chunk` "12: " line-number prefixes
    let inferredStartHint = op.hintStartLine;
    if (spans.length === 0) {
      const strippedOld = stripReadChunkLineNumberPrefixes(effectiveOld);
      if (strippedOld.didStrip) {
        const strippedNew = stripReadChunkLineNumberPrefixes(effectiveNew);
        const candidateOld = alignEol(strippedOld.stripped);
        const candidateNew = strippedNew.didStrip
          ? alignEol(strippedNew.stripped)
          : alignEol(effectiveNew);
        let candidateSpans = findExactSpans(updatedContent, candidateOld);
        if (candidateSpans.length === 0) {
          candidateSpans = findLineNormalizedSpans(updatedContent, candidateOld, 'trim_end');
        }
        if (candidateSpans.length === 0) {
          candidateSpans = findLineNormalizedSpans(updatedContent, candidateOld, 'trim_both');
        }
        if (candidateSpans.length > 0) {
          spans = candidateSpans;
          effectiveOld = candidateOld;
          effectiveNew = candidateNew;
          if (!inferredStartHint && strippedOld.firstLineNum) {
            inferredStartHint = strippedOld.firstLineNum;
          }
        }
      }
    }

    // Tier 3: Trailing-whitespace normalized line-block match
    if (spans.length === 0) {
      const trimEndSpans = findLineNormalizedSpans(updatedContent, effectiveOld, 'trim_end');
      if (trimEndSpans.length > 0) {
        spans = trimEndSpans;
        effectiveNew = alignEol(effectiveNew);
      }
    }

    // Tier 4: Indentation-agnostic trimmed line-block match (re-indents replacement)
    if (spans.length === 0) {
      const trimBothSpans = findLineNormalizedSpans(updatedContent, effectiveOld, 'trim_both');
      if (trimBothSpans.length > 0) {
        spans = trimBothSpans;
      }
    }

    if (spans.length === 0) {
      return makeEditFileError(
        `old_text was not found in '${target.filename}'.${buildClosestMatchHint(updatedContent, op.oldText)}`,
      );
    }

    // Disambiguate multiple matches using start_line hint if available
    if (spans.length > 1 && !op.replaceAll) {
      if (inferredStartHint !== undefined) {
        const ranked = [...spans].sort(
          (a, b) =>
            Math.abs(a.lineNumber - inferredStartHint!) -
            Math.abs(b.lineNumber - inferredStartHint!),
        );
        const bestDist = Math.abs(ranked[0].lineNumber - inferredStartHint);
        const secondDist = Math.abs(ranked[1].lineNumber - inferredStartHint);
        if (bestDist <= 15 && bestDist < secondDist) {
          spans = [ranked[0]];
        }
      }

      if (spans.length > 1) {
        const locations = spans.slice(0, 6).map((s) => `L${s.lineNumber}`).join(', ');
        return makeEditFileError(
          `old_text matched ${spans.length} locations in '${target.filename}' (${locations}). Include more surrounding context, pass start_line to pick one, or set replace_all: true.`,
        );
      }
    }

    // Apply replacements from end to start so offsets stay valid
    const targets = op.replaceAll ? [...spans].reverse() : [spans[0]];
    const currentEol: '\r\n' | '\n' = fileHasCrlf ? '\r\n' : '\n';
    for (const span of targets) {
      const replacementPiece =
        span.indentDelta || span.removeIndentCols
          ? adjustReplacementIndentation(effectiveNew, span, currentEol)
          : alignEol(effectiveNew);
      updatedContent =
        updatedContent.slice(0, span.start) + replacementPiece + updatedContent.slice(span.end);
    }
  }

  const updatedArtifact: GeneratedFileArtifact = {
    ...target,
    content: updatedContent,
  };

  const { linesChanged, previewDiff } = computeLineDiff(target.content, updatedContent);
  const totalLines = countLines(updatedContent);

  return {
    ok: true,
    artifact: updatedArtifact,
    linesChanged,
    totalLines,
    previewDiff,
    toolResultJson: JSON.stringify({
      status: 'ok',
      filename: updatedArtifact.filename,
      linesChanged,
      totalLines,
      previewDiff,
      message: `Updated '${updatedArtifact.filename}' (${linesChanged} line(s) changed, ${totalLines} total lines). Do NOT paste the full file contents in your reply—only summarize the changes made.`,
    }),
  };
}

// ---------------------------------------------------------------------------
// 3. `read_attached_chunk` tool & `buildAttachedFileIndex`
// ---------------------------------------------------------------------------

const MAX_OUTLINE_ENTRIES = 15;

const OUTLINE_PATTERNS: RegExp[] = [
  /^(#{1,6}\s+.+)$/,
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
  /^class\s+([A-Za-z_][\w]*)\s*[:(]/,
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\s+([A-Za-z_][\w:<>,\s]*)/,
  /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*\(/,
  /^type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/,
  /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|FUNCTION|PROCEDURE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i,
  /^\[([^\]]+)\]\s*$/,
];

function extractOutlineEntries(lines: string[]): string[] {
  const entries: string[] = [];

  for (let i = 0; i < lines.length && entries.length < MAX_OUTLINE_ENTRIES; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.length > 240) continue;

    let matched = false;
    for (const pattern of OUTLINE_PATTERNS) {
      if (pattern.test(trimmed)) {
        entries.push(`L${i + 1}: ${safeTruncateChars(trimmed, 80)}`);
        matched = true;
        break;
      }
    }

    if (
      !matched &&
      (/^([A-Za-z0-9_.-]+):(?:\s|$)/.test(lines[i]) ||
        /^\s{1,2}"([^"]{1,60})"\s*:/.test(lines[i]))
    ) {
      entries.push(`L${i + 1}: ${safeTruncateChars(trimmed, 80)}`);
    }
  }

  return entries;
}

export function buildAttachedFileIndex(name: string, content: string): string {
  const { lines } = splitFileLines(content);
  const totalLines = lines.length;
  const byteCount = new TextEncoder().encode(content).length;
  const outline = extractOutlineEntries(lines);

  const header = `Attached file: ${name} (${totalLines} lines, ${byteCount} bytes)`;
  const outlineBlock =
    outline.length > 0
      ? `Outline (${outline.length}${outline.length === MAX_OUTLINE_ENTRIES ? '+' : ''}):\n${outline.map((entry) => `- ${entry}`).join('\n')}`
      : 'Outline: no structural headings/symbols detected';

  return `${header}\n${outlineBlock}\nUse ${READ_ATTACHED_CHUNK_TOOL_NAME}(filename="${name}", start_line=1, end_line=${Math.min(MAX_ATTACHED_CHUNK_LINES, Math.max(1, totalLines))}) to read numbered lines.`;
}

function makeReadChunkError(error: string): ReadAttachedChunkToolResult {
  return {
    ok: false,
    error,
    toolResultJson: JSON.stringify({ status: 'error', error }),
  };
}

export function executeReadAttachedChunkTool(
  rawArguments: string,
  attachedFiles: AttachedFileInput[],
): ReadAttachedChunkToolResult {
  const args = parseToolArgumentsJson(rawArguments);
  if (!args) {
    return makeReadChunkError(
      'Invalid JSON arguments for read_attached_chunk. Provide an object with optional filename, start_line, and end_line.',
    );
  }

  const requestedReadFilename = extractEditTargetFilename(args);
  if (args.filename !== undefined && args.filename !== null && typeof args.filename !== 'string') {
    return makeReadChunkError('read_attached_chunk "filename" must be a string when provided.');
  }

  const match = resolveFileByName(
    attachedFiles,
    requestedReadFilename || undefined,
    (f) => f.name,
    'No attached files are available in this conversation.',
    true,
  );
  if (!match.ok) {
    return makeReadChunkError(match.error);
  }

  const target = match.item;
  const startField = pickFirstDefinedField(args, START_LINE_ALIAS_KEYS);
  const startLine = startField === null ? 1 : parsePositiveIntLike(startField.value);
  if (startLine === null) {
    return makeReadChunkError('read_attached_chunk "start_line" must be a positive integer (>= 1).');
  }

  const endField = pickFirstDefinedField(args, END_LINE_ALIAS_KEYS);
  let parsedEndLine: number | undefined;
  if (endField !== null) {
    const candidateEnd = parsePositiveIntLike(endField.value);
    if (candidateEnd === null || candidateEnd < startLine) {
      return makeReadChunkError(
        `read_attached_chunk "end_line" must be an integer >= start_line (${startLine}).`,
      );
    }
    parsedEndLine = candidateEnd;
  }

  const { lines } = splitFileLines(target.content);
  const totalLines = lines.length;

  if (totalLines === 0) {
    if (startLine > 1) {
      return makeReadChunkError(
        `start_line (${startLine}) exceeds total lines (0) in '${target.name}'.`,
      );
    }
    return {
      ok: true,
      filename: target.name,
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      linesReturned: 0,
      hasMore: false,
      capped: false,
      content: '',
      toolResultJson: JSON.stringify({
        status: 'ok',
        filename: target.name,
        start_line: 1,
        end_line: 0,
        total_lines: 0,
        lines_returned: 0,
        has_more: false,
        content: '',
      }),
    };
  }

  if (startLine > totalLines) {
    return makeReadChunkError(
      `start_line (${startLine}) exceeds total lines (${totalLines}) in '${target.name}'.`,
    );
  }

  const maxAllowedEnd = startLine + MAX_ATTACHED_CHUNK_LINES - 1;
  const requestedEnd = parsedEndLine ?? maxAllowedEnd;
  const capped = requestedEnd - startLine + 1 > MAX_ATTACHED_CHUNK_LINES;
  const effectiveEnd = Math.min(totalLines, requestedEnd, maxAllowedEnd);

  const slice = lines.slice(startLine - 1, effectiveEnd);
  const numberedContent = slice.map((line, idx) => `${startLine + idx}: ${line}`).join('\n');
  const hasMore = effectiveEnd < totalLines;

  return {
    ok: true,
    filename: target.name,
    startLine,
    endLine: effectiveEnd,
    totalLines,
    linesReturned: slice.length,
    hasMore,
    capped,
    content: numberedContent,
    toolResultJson: JSON.stringify({
      status: 'ok',
      filename: target.name,
      start_line: startLine,
      end_line: effectiveEnd,
      total_lines: totalLines,
      lines_returned: slice.length,
      has_more: hasMore,
      ...(hasMore ? { next_start_line: effectiveEnd + 1 } : {}),
      ...(capped ? { note: `Capped at ${MAX_ATTACHED_CHUNK_LINES} lines per read.` } : {}),
      content: numberedContent,
    }),
  };
}

// ---------------------------------------------------------------------------
// 4. `search_memory` & `save_memory_note` tools
// ---------------------------------------------------------------------------

function makeSearchMemoryError(error: string): SearchMemoryToolResult {
  return {
    ok: false,
    error,
    toolResultJson: JSON.stringify({ status: 'error', error }),
  };
}

export function executeSearchMemoryTool(
  rawArguments: string,
  notes: MemoryNote[],
  sessionId?: string,
): SearchMemoryToolResult {
  const args = parseToolArgumentsJson(rawArguments);
  if (!args) {
    return makeSearchMemoryError(
      'Invalid JSON arguments for search_memory. Provide an object with a query string.',
    );
  }

  if (args.pinned_only !== undefined && typeof args.pinned_only !== 'boolean') {
    return makeSearchMemoryError('search_memory "pinned_only" must be a boolean.');
  }
  const pinnedOnly = args.pinned_only === true;

  if (args.query !== undefined && typeof args.query !== 'string') {
    return makeSearchMemoryError('search_memory "query" must be a string.');
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';

  if (!pinnedOnly && !query) {
    return makeSearchMemoryError(
      'search_memory requires a non-empty "query" string (unless pinned_only is true).',
    );
  }

  let limit = DEFAULT_SEARCH_MEMORY_LIMIT;
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isFinite(args.limit)) {
      return makeSearchMemoryError('search_memory "limit" must be a finite number.');
    }
    limit = Math.max(1, Math.min(MAX_SEARCH_MEMORY_LIMIT, Math.floor(args.limit)));
  }

  const hits = retrieveMemoryNotes(notes, {
    query: query || undefined,
    sessionId,
    limit,
    includeDisabled: false,
    requireApproved: true,
    pinnedOnly,
  });

  const results: MemorySearchHitExcerpt[] = hits.map((hit) => ({
    id: hit.note.id,
    title: hit.note.title,
    content: safeTruncateChars(hit.note.content.trim(), 320),
    sourceReference: hit.note.sourceReference,
    isPinned: hit.note.isPinned,
    score: Number(hit.finalScore.toFixed(4)),
  }));

  return {
    ok: true,
    results,
    count: results.length,
    toolResultJson: JSON.stringify({
      status: 'ok',
      query,
      count: results.length,
      results,
    }),
  };
}

function makeSaveMemoryError(error: string): SaveMemoryNoteToolResult {
  return {
    ok: false,
    error,
    toolResultJson: JSON.stringify({ status: 'error', error }),
  };
}

export function executeSaveMemoryNoteTool(
  rawArguments: string,
  createId: () => string,
  sessionTitle?: string,
  sessionId?: string,
  options?: SaveMemoryNoteOptions,
): SaveMemoryNoteToolResult {
  const args = parseToolArgumentsJson(rawArguments);
  if (!args) {
    return makeSaveMemoryError(
      'Invalid JSON arguments for save_memory_note. Provide an object with title and content.',
    );
  }

  const rawTitle = typeof args.title === 'string' ? args.title.trim() : '';
  if (!rawTitle) {
    return makeSaveMemoryError('save_memory_note requires a non-empty string "title" field.');
  }

  const rawContent = typeof args.content === 'string' ? args.content.trim() : '';
  if (!rawContent) {
    return makeSaveMemoryError('save_memory_note requires a non-empty string "content" field.');
  }

  if (args.is_pinned !== undefined && typeof args.is_pinned !== 'boolean') {
    return makeSaveMemoryError('save_memory_note optional "is_pinned" field must be a boolean.');
  }

  const isPinned = args.is_pinned === true;
  const nowMs = options?.nowMs ?? Date.now();
  const userApproved = options?.userApproved ?? true;
  const trimmedSessionTitle = sessionTitle?.trim();
  const sourceReference = trimmedSessionTitle
    ? `Saved via AI tool (${safeTruncateChars(trimmedSessionTitle, 60)})`
    : 'Saved via AI tool';
  const boundedContent = safeTruncateChars(rawContent, MAX_SAVED_NOTE_CONTENT_CHARS);

  const note: MemoryNote = {
    id: `note_${createId().slice(0, 8)}`,
    ...(sessionId ? { sessionId } : {}),
    title: safeTruncateChars(rawTitle, 120),
    content: boundedContent,
    sourceReference,
    sourceMessageIds: [],
    isPinned,
    isSummary: false,
    isDisabled: false,
    userApproved,
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  return {
    ok: true,
    note,
    toolResultJson: JSON.stringify({
      status: 'ok',
      id: note.id,
      title: note.title,
      isPinned: note.isPinned,
      userApproved: note.userApproved,
      sourceReference: note.sourceReference,
      ...(boundedContent !== rawContent ? { truncated: true } : {}),
      message: `Saved memory note '${note.title}'${note.isPinned ? ' (pinned)' : ''}.`,
    }),
  };
}

function makeSaveWorkspaceFileError(error: string): SaveWorkspaceFileToolResult {
  return {
    ok: false,
    error,
    toolResultJson: JSON.stringify({ status: 'error', error }),
  };
}

export function executeSaveWorkspaceFileTool(
  rawArguments: string,
  existingFiles: WorkspaceFile[],
  sessionSourceFiles: AttachedFileAttachment[],
  createId: () => string,
  options: SaveWorkspaceFileOptions = {},
): SaveWorkspaceFileToolResult {
  const args = parseToolArgumentsJson(rawArguments);
  if (!args) {
    return makeSaveWorkspaceFileError(
      'Invalid JSON arguments for save_workspace_file. Provide an object with filename and optional content.',
    );
  }

  const rawFilename = typeof args.filename === 'string' ? args.filename.trim() : '';
  if (!rawFilename) {
    return makeSaveWorkspaceFileError('save_workspace_file requires a non-empty string "filename".');
  }

  let resolvedContent = typeof args.content === 'string' ? args.content : '';
  if (!resolvedContent.trim()) {
    const match = resolveFileByName(
      sessionSourceFiles,
      rawFilename,
      (f) => f.name,
      'No content provided and no matching attached or generated file exists in this session.',
      true,
    );
    if (!match.ok) {
      return makeSaveWorkspaceFileError(
        `save_workspace_file requires "content" or a matching session file for '${rawFilename}'.`,
      );
    }
    resolvedContent = match.item.content;
  }

  if (!resolvedContent.trim()) {
    return makeSaveWorkspaceFileError('save_workspace_file content cannot be empty.');
  }

  const res = upsertWorkspaceFile(
    existingFiles,
    {
      filename: rawFilename,
      content: resolvedContent,
      title: typeof args.title === 'string' ? args.title : undefined,
      language: typeof args.language === 'string' ? args.language : undefined,
      source: 'ai',
    },
    createId,
    {
      allowAiEdit: options.allowAiFileEdits,
      nowMs: options.nowMs,
    },
  );

  if (!res.ok) {
    return makeSaveWorkspaceFileError(res.error);
  }

  const lines = countLines(res.file.content);
  return {
    ok: true,
    file: res.file,
    files: res.files,
    action: res.action,
    toolResultJson: JSON.stringify({
      status: 'ok',
      action: res.action,
      id: res.file.id,
      filename: res.file.filename,
      language: res.file.language,
      lines,
      sizeBytes: res.file.sizeBytes,
      message: `${res.action === 'created' ? 'Saved' : 'Updated'} '${res.file.filename}' (${lines} lines) in the persistent Files tab. Future chats can inspect it via read_attached_chunk.`,
    }),
  };
}
