import type { GeneratedFileArtifact, ToolDefinition } from './types';

export const CREATE_FILE_TOOL_NAME = 'create_file';

export const TOOL_CALL_POLICY_INSTRUCTION = `[File Creation Tool Policy]
You have access to the \`${CREATE_FILE_TOOL_NAME}\` tool to create downloadable, previewable code or text files.
- ONLY call \`${CREATE_FILE_TOOL_NAME}\` when the user asks to create, generate, write, or save a complete standalone file, script, program, or module (for example: "generate a Rust file...", "write a Python script...", "create config.yaml").
- Do NOT call \`${CREATE_FILE_TOOL_NAME}\` for short code examples, snippets, quick syntax demonstrations, single functions/commands, or inline explanations. Use normal markdown code blocks for examples and snippets.
- When you DO call \`${CREATE_FILE_TOOL_NAME}\`, do NOT repeat the full file contents inside a markdown code block in your final reply; the file preview card is attached automatically at the end of your message. Keep your final reply concise, explaining the implementation and how to run or use it.`;

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
      message: `File '${artifact.filename}' (${lines} lines) has been created and attached as a previewable card at the end of your response. Do NOT repeat the full file code in your reply; concisely explain the implementation and how to use or run it.`,
    }),
  };
}
