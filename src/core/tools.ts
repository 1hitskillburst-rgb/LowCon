import type { GeneratedFileArtifact, ToolDefinition } from './types';

export const CREATE_FILE_TOOL_NAME = 'create_file';

export const TOOL_CALL_POLICY_INSTRUCTION = `[File Creation Tool Policy]
You have access to the \`${CREATE_FILE_TOOL_NAME}\` tool to create downloadable, previewable code or text files.
- ONLY call \`${CREATE_FILE_TOOL_NAME}\` when the user asks to create, generate, write, or save a complete standalone file, script, program, or module (for example: "generate a Rust file...", "write a Python script...", "create config.yaml").
- Do NOT call \`${CREATE_FILE_TOOL_NAME}\` for short code examples, snippets, quick syntax demonstrations, single functions/commands, or inline explanations. Use normal markdown code blocks for examples and snippets.
- CRITICAL: When you DO call \`${CREATE_FILE_TOOL_NAME}\`, NEVER paste, repeat, or echo the file's code in a markdown code block in your text response. The file is already attached as an interactive preview card for the user. Reply only with concise prose explaining the implementation and optional 1–3 line CLI run/test commands.`;

export const CREATE_FILE_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: CREATE_FILE_TOOL_NAME,
    description:
      'Create a standalone code or text file and attach it as a previewable card at the end of the response. Use ONLY for full-file requests (scripts, programs, modules, config files), NOT for short code snippets or inline examples.',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description:
            'File name with extension, e.g. "recursive_linked_list.rs" or "server.py". Must be a plain file name or relative path without ".." segments.',
        },
        title: {
          type: 'string',
          description:
            'Short human-readable title shown on the file card, e.g. "Recursive linked list".',
        },
        language: {
          type: 'string',
          description:
            'Programming language or format identifier, e.g. "rust", "typescript", "python".',
        },
        content: {
          type: 'string',
          description: 'Complete contents of the file.',
        },
      },
      required: ['filename', 'content'],
      additionalProperties: false,
    },
  },
};

const EXT_TO_LANGUAGE: Record<string, string> = {
  rs: 'rust',
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  md: 'markdown',
  txt: 'text',
};

const LANGUAGE_TO_EXT: Record<string, string> = {
  rust: 'rs',
  typescript: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  jsx: 'jsx',
  python: 'py',
  go: 'go',
  ruby: 'rb',
  java: 'java',
  kotlin: 'kt',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  bash: 'sh',
  shell: 'sh',
  powershell: 'ps1',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  markdown: 'md',
  text: 'txt',
};

export function sanitizeGeneratedFilename(rawFilename: string, rawLanguage?: string): string {
  const cleaned = rawFilename
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .pop()
    ?.replace(/[\0<>:"|?*]/g, '_')
    .trim();

  if (cleaned) {
    return cleaned;
  }
  const langKey = (rawLanguage ?? '').trim().toLowerCase();
  const ext = LANGUAGE_TO_EXT[langKey] ?? 'txt';
  return `generated_file.${ext}`;
}

export function inferLanguageFromFilename(filename: string, explicitLanguage?: string): string {
  const trimmedLang = explicitLanguage?.trim().toLowerCase();
  if (trimmedLang) return trimmedLang;
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx !== -1 && dotIdx < filename.length - 1) {
    const ext = filename.slice(dotIdx + 1).toLowerCase();
    return EXT_TO_LANGUAGE[ext] ?? ext;
  }
  return 'text';
}

export function formatTitleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const spaced = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) return filename;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function getFileExtensionBadge(filename: string, language: string): string {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx !== -1 && dotIdx < filename.length - 1) {
    return filename.slice(dotIdx + 1).toUpperCase();
  }
  return (language || 'TEXT').toUpperCase();
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

export function parseToolArgumentsJson(rawArgs: string): Record<string, unknown> | null {
  const trimmed = rawArgs.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Attempt recovery if model wrapped JSON in markdown fences
    const unfenced = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    if (unfenced !== trimmed) {
      try {
        const parsed = JSON.parse(unfenced) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function executeCreateFileTool(
  rawArguments: string,
  createId: () => string,
):
  | { ok: true; artifact: GeneratedFileArtifact; toolResultJson: string }
  | { ok: false; error: string; toolResultJson: string } {
  const args = parseToolArgumentsJson(rawArguments);
  if (!args) {
    const error = 'Invalid JSON arguments for create_file. Provide an object with filename and content.';
    return {
      ok: false,
      error,
      toolResultJson: JSON.stringify({ status: 'error', error }),
    };
  }

  const rawContent = typeof args.content === 'string' ? args.content : '';
  if (!rawContent.trim()) {
    const error = 'create_file requires a non-empty string "content" field.';
    return {
      ok: false,
      error,
      toolResultJson: JSON.stringify({ status: 'error', error }),
    };
  }

  const rawFilename = typeof args.filename === 'string' ? args.filename : '';
  const rawLanguage = typeof args.language === 'string' ? args.language : '';
  const filename = sanitizeGeneratedFilename(rawFilename, rawLanguage);
  const language = inferLanguageFromFilename(filename, rawLanguage);
  const title =
    typeof args.title === 'string' && args.title.trim()
      ? args.title.trim()
      : formatTitleFromFilename(filename);

  const artifact: GeneratedFileArtifact = {
    id: `file_${createId().slice(0, 8)}`,
    filename,
    title,
    language,
    content: rawContent,
    createdAt: Date.now(),
  };

  const lines = countLines(rawContent);
  const bytes = new TextEncoder().encode(rawContent).length;

  return {
    ok: true,
    artifact,
    toolResultJson: JSON.stringify({
      status: 'ok',
      filename: artifact.filename,
      title: artifact.title,
      language: artifact.language,
      lines,
      bytes,
      message: `File '${artifact.filename}' (${lines} lines) is saved and attached as a preview card for the user. Do NOT write or repeat the file's code in your reply—no code blocks of the file contents. Reply in concise prose explaining what was built and how to run it.`,
    }),
  };
}

const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'powershell', 'ps1', 'cmd', 'console']);

function normalizeCodeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && !/^[{}[\]();,]+$/.test(line));
}

/**
 * Returns true when a fenced code block emitted after `create_file` substantially
 * duplicates one of the generated files (while preserving short CLI usage examples).
 */
export function isDuplicateGeneratedFileBlock(
  fenceLang: string,
  fenceBody: string,
  generatedFiles: GeneratedFileArtifact[],
): boolean {
  if (generatedFiles.length === 0) return false;
  const blockLines = normalizeCodeLines(fenceBody);
  if (blockLines.length <= 5) return false;

  const cleanLang = fenceLang.trim().toLowerCase();
  const isShellBlock = SHELL_LANGS.has(cleanLang);

  for (const file of generatedFiles) {
    if (isShellBlock && !SHELL_LANGS.has(file.language.toLowerCase())) {
      continue;
    }

    const fileLines = normalizeCodeLines(file.content);
    if (fileLines.length === 0) continue;

    const fileLineSet = new Set(fileLines);
    let matches = 0;
    for (const line of blockLines) {
      if (fileLineSet.has(line)) matches += 1;
    }

    const matchRatio = matches / blockLines.length;
    if (matchRatio >= 0.45 || matches >= 10) {
      return true;
    }

    const normalizedBlock = blockLines.join('\n');
    const normalizedFile = fileLines.join('\n');
    if (normalizedBlock.length >= 120 && normalizedFile.includes(normalizedBlock)) {
      return true;
    }
  }

  return false;
}

/**
 * Streaming filter that buffers fenced code blocks only after at least one file
 * was created in the current turn, stripping blocks that duplicate the created file.
 */
export class DuplicateFileCodeFilter {
  private getFiles: () => GeneratedFileArtifact[];
  private onEmit: (text: string) => void;
  private lineBuffer = '';
  private inFence = false;
  private fenceChar = '`';
  private fenceLen = 3;
  private fenceLang = '';
  private fenceLines: string[] = [];

  constructor(getFiles: () => GeneratedFileArtifact[], onEmit: (text: string) => void) {
    this.getFiles = getFiles;
    this.onEmit = onEmit;
  }

  private handleLine(lineWithBreak: string, hasBreak: boolean): void {
    const files = this.getFiles();
    if (!this.inFence && files.length === 0) {
      this.onEmit(lineWithBreak);
      return;
    }

    const rawLine = hasBreak ? lineWithBreak.replace(/\r?\n$/, '') : lineWithBreak;

    if (!this.inFence) {
      const openMatch = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(rawLine);
      if (openMatch) {
        this.inFence = true;
        this.fenceChar = openMatch[1][0];
        this.fenceLen = openMatch[1].length;
        this.fenceLang = openMatch[2].trim();
        this.fenceLines = [lineWithBreak];
        return;
      }
      this.onEmit(lineWithBreak);
      return;
    }

    this.fenceLines.push(lineWithBreak);
    const trimmed = rawLine.trim();
    const isCloseFence =
      trimmed.length >= this.fenceLen &&
      [...trimmed].every((ch) => ch === this.fenceChar);

    if (isCloseFence) {
      const body = this.fenceLines.slice(1, -1).join('');
      const suppress = isDuplicateGeneratedFileBlock(this.fenceLang, body, files);
      const fullBlock = this.fenceLines.join('');
      this.inFence = false;
      this.fenceLang = '';
      this.fenceLines = [];
      if (!suppress) {
        this.onEmit(fullBlock);
      }
    }
  }

  push(chunk: string): void {
    if (!chunk) return;
    if (!this.inFence && !this.lineBuffer && this.getFiles().length === 0) {
      this.onEmit(chunk);
      return;
    }

    this.lineBuffer += chunk;

    while (this.lineBuffer.length > 0) {
      const nlIdx = this.lineBuffer.indexOf('\n');
      if (nlIdx !== -1) {
        const line = this.lineBuffer.slice(0, nlIdx + 1);
        this.lineBuffer = this.lineBuffer.slice(nlIdx + 1);
        this.handleLine(line, true);
        continue;
      }

      // If not inside a fence and the partial line cannot be a fence opener, emit immediately
      if (!this.inFence && !/^ {0,3}(?:`{1,}|~{1,})/.test(this.lineBuffer)) {
        const safeText = this.lineBuffer;
        this.lineBuffer = '';
        this.onEmit(safeText);
      }
      break;
    }
  }

  flush(): void {
    if (this.lineBuffer) {
      const rest = this.lineBuffer;
      this.lineBuffer = '';
      this.handleLine(rest, false);
    }
    if (this.inFence) {
      const body = this.fenceLines.slice(1).join('');
      const suppress = isDuplicateGeneratedFileBlock(this.fenceLang, body, this.getFiles());
      const fullBlock = this.fenceLines.join('');
      this.inFence = false;
      this.fenceLang = '';
      this.fenceLines = [];
      if (!suppress) {
        this.onEmit(fullBlock);
      }
    }
  }
}
