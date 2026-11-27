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
      'Patch an existing session or persistent Files-tab file in place via edits[] or top-level (start_line, end_line, replacement) or (old_text, new_text). Prefer this over create_file when modifying an existing file.',
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
            additionalProperties: false,
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
      additionalProperties: false,
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
  const hasEditable = options.hasGeneratedFiles || Boolean(options.hasWorkspaceFiles);
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
}

type ParsedEditOp = LineRangeEditOp | ExactTextEditOp;

function parseSingleEditOp(raw: unknown, indexLabel: string): ParsedEditOp | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `${indexLabel} must be an object.`;
  }
  const rec = raw as Record<string, unknown>;

  const hasLineFields =
    rec.start_line !== undefined || rec.end_line !== undefined || rec.replacement !== undefined;
  const hasTextFields = rec.old_text !== undefined || rec.new_text !== undefined;

  if (hasLineFields && hasTextFields) {
    return `${indexLabel} cannot mix line-range fields (start_line/end_line/replacement) with exact-text fields (old_text/new_text).`;
  }

  if (hasLineFields) {
    if (
      typeof rec.start_line !== 'number' ||
      !Number.isInteger(rec.start_line) ||
      rec.start_line < 1
    ) {
      return `${indexLabel} requires a positive integer "start_line".`;
    }
    const startLine = rec.start_line;
    const endLine = rec.end_line === undefined ? startLine : rec.end_line;
    if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < startLine) {
      return `${indexLabel} "end_line" must be an integer >= start_line (${startLine}).`;
    }
    if (typeof rec.replacement !== 'string') {
      return `${indexLabel} requires a string "replacement" field.`;
    }
    return {
      kind: 'line_range',
      startLine,
      endLine,
      replacement: rec.replacement,
    };
  }

  if (hasTextFields) {
    if (typeof rec.old_text !== 'string' || rec.old_text.length === 0) {
      return `${indexLabel} requires a non-empty string "old_text" field.`;
    }
    if (typeof rec.new_text !== 'string') {
      return `${indexLabel} requires a string "new_text" field.`;
    }
    if (rec.replace_all !== undefined && typeof rec.replace_all !== 'boolean') {
      return `${indexLabel} optional "replace_all" must be a boolean.`;
    }
    return {
      kind: 'exact_text',
      oldText: rec.old_text,
      newText: rec.new_text,
      replaceAll: rec.replace_all === true,
    };
  }

  return `${indexLabel} must specify either (start_line, replacement) or (old_text, new_text).`;
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

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
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

  const requestedFilename = typeof args.filename === 'string' ? args.filename : '';
  const match = resolveFileByName(
    existingFiles,
    requestedFilename,
    (f) => f.filename,
    'No generated files exist in this session yet. Use create_file first.',
    false,
  );
  if (!match.ok) {
    return makeEditFileError(match.error);
  }

  const target = match.item;
  const parsedOps: ParsedEditOp[] = [];

  if (args.edits !== undefined) {
    if (!Array.isArray(args.edits) || args.edits.length === 0) {
      return makeEditFileError('edit_file "edits" must be a non-empty array of edit operations.');
    }
    for (let i = 0; i < args.edits.length; i++) {
      const op = parseSingleEditOp(args.edits[i], `edits[${i}]`);
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

  if (lineOps.length > 0 && textOps.length > 0) {
    return makeEditFileError(
      'edit_file cannot mix line-range edits and old_text/new_text edits in the same call.',
    );
  }

  let updatedContent = target.content;

  // Apply line-range edits first, validated against original line bounds and applied bottom-to-top
  if (lineOps.length > 0) {
    const { lines, hasTrailingNewline, eol } = splitFileLines(updatedContent);
    const total = lines.length;

    for (const op of lineOps) {
      if (total === 0 || op.endLine > total) {
        return makeEditFileError(
          `Line range ${op.startLine}-${op.endLine} is out of bounds for '${target.filename}' (${total} lines).`,
        );
      }
    }

    const sortedByStart = [...lineOps].sort((a, b) => a.startLine - b.startLine);
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
      workingLines.splice(op.startLine - 1, op.endLine - op.startLine + 1, ...replacementLines);
    }

    updatedContent = joinFileLines(
      workingLines,
      hasTrailingNewline || (total === 0 && workingLines.length > 0 && target.content.endsWith('\n')),
      eol,
    );
  }

  // Apply exact-text edits sequentially
  for (const op of textOps) {
    let needle = op.oldText;
    let replacementText = op.newText;

    if (!updatedContent.includes(needle) && updatedContent.includes('\r\n')) {
      const crlfNeedle = needle.replace(/\r?\n/g, '\r\n');
      if (updatedContent.includes(crlfNeedle)) {
        needle = crlfNeedle;
        replacementText = replacementText.replace(/\r?\n/g, '\r\n');
      }
    }

    const hits = countOccurrences(updatedContent, needle);
    if (hits === 0) {
      return makeEditFileError(
        `old_text was not found in '${target.filename}'. Verify exact whitespace and indentation.`,
      );
    }
    if (hits > 1 && !op.replaceAll) {
      return makeEditFileError(
        `old_text matched ${hits} locations in '${target.filename}'. Include more context to make it unique or set replace_all: true.`,
      );
    }

    updatedContent = op.replaceAll
      ? updatedContent.split(needle).join(replacementText)
      : updatedContent.replace(needle, () => replacementText);
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

  if (args.filename !== undefined && typeof args.filename !== 'string') {
    return makeReadChunkError('read_attached_chunk "filename" must be a string when provided.');
  }

  const match = resolveFileByName(
    attachedFiles,
    typeof args.filename === 'string' ? args.filename : undefined,
    (f) => f.name,
    'No attached files are available in this conversation.',
    true,
  );
  if (!match.ok) {
    return makeReadChunkError(match.error);
  }

  const target = match.item;
  const startLine = args.start_line === undefined ? 1 : args.start_line;
  if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
    return makeReadChunkError('read_attached_chunk "start_line" must be a positive integer (>= 1).');
  }

  if (args.end_line !== undefined) {
    if (
      typeof args.end_line !== 'number' ||
      !Number.isInteger(args.end_line) ||
      args.end_line < startLine
    ) {
      return makeReadChunkError(
        `read_attached_chunk "end_line" must be an integer >= start_line (${startLine}).`,
      );
    }
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
  const requestedEnd =
    typeof args.end_line === 'number' ? args.end_line : maxAllowedEnd;
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
