import {
  countLines,
  formatTitleFromFilename,
  getFileExtensionBadge,
  inferLanguageFromFilename,
  sanitizeGeneratedFilename,
} from './tools';
import type { GeneratedFileArtifact, WorkspaceFile, WorkspaceFileSource } from './types';

export type WorkspaceFileSortField = 'updatedAt' | 'createdAt' | 'name' | 'type' | 'size';
export type SortDirection = 'asc' | 'desc';

export const MAX_WORKSPACE_FILE_BYTES = 256 * 1024;
export const DEFAULT_SORT_DIRECTIONS: Record<WorkspaceFileSortField, SortDirection> = {
  updatedAt: 'desc',
  createdAt: 'desc',
  name: 'asc',
  type: 'asc',
  size: 'desc',
};

export function computeUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function formatWorkspaceFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

export function getWorkspaceFileExtension(file: Pick<WorkspaceFile, 'filename' | 'language'>): string {
  return getFileExtensionBadge(file.filename, file.language);
}

export function filterAndSortWorkspaceFiles(
  files: WorkspaceFile[],
  searchQuery: string,
  sortBy: WorkspaceFileSortField,
  sortDir: SortDirection,
): WorkspaceFile[] {
  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? files.filter(
        (f) =>
          f.filename.toLowerCase().includes(q) ||
          f.title.toLowerCase().includes(q) ||
          f.language.toLowerCase().includes(q),
      )
    : [...files];

  const dir = sortDir === 'asc' ? 1 : -1;

  return filtered.sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'name':
        cmp = a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' });
        break;
      case 'type': {
        const typeA = getWorkspaceFileExtension(a);
        const typeB = getWorkspaceFileExtension(b);
        cmp = typeA.localeCompare(typeB, undefined, { sensitivity: 'base' });
        if (cmp === 0) {
          cmp = a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' });
        }
        break;
      }
      case 'createdAt':
        cmp = a.createdAt - b.createdAt;
        break;
      case 'size':
        cmp = a.sizeBytes - b.sizeBytes;
        break;
      case 'updatedAt':
      default:
        cmp = a.updatedAt - b.updatedAt;
        break;
    }
    if (cmp === 0) {
      cmp = a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' });
    }
    return cmp * dir;
  });
}

export interface UpsertWorkspaceFileInput {
  filename: string;
  content: string;
  title?: string;
  language?: string;
  source: WorkspaceFileSource;
  lockedByUser?: boolean;
}

export interface UpsertWorkspaceFileOptions {
  allowAiEdit?: boolean;
  nowMs?: number;
}

export type UpsertWorkspaceFileResult =
  | {
      ok: true;
      file: WorkspaceFile;
      files: WorkspaceFile[];
      action: 'created' | 'updated';
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Inserts or updates a file in the persistent workspace Files store while enforcing
 * global AI-edit and per-file user lock permissions when invoked by an LLM.
 */
export function upsertWorkspaceFile(
  files: WorkspaceFile[],
  input: UpsertWorkspaceFileInput,
  createId: () => string,
  options: UpsertWorkspaceFileOptions = {},
): UpsertWorkspaceFileResult {
  const filename = sanitizeGeneratedFilename(input.filename, input.language);
  const sizeBytes = computeUtf8Bytes(input.content);
  if (sizeBytes > MAX_WORKSPACE_FILE_BYTES) {
    return {
      ok: false,
      error: `File '${filename}' (${formatWorkspaceFileSize(sizeBytes)}) exceeds the ${Math.round(MAX_WORKSPACE_FILE_BYTES / 1024)} KB local workspace limit.`,
    };
  }

  const now = options.nowMs ?? Date.now();
  const language = inferLanguageFromFilename(filename, input.language);
  const title = input.title?.trim() ? input.title.trim() : formatTitleFromFilename(filename);

  const existingIdx = files.findIndex((f) => f.filename.toLowerCase() === filename.toLowerCase());
  const isAiInitiated = input.source === 'ai';

  if (existingIdx !== -1) {
    const existing = files[existingIdx];
    if (isAiInitiated) {
      if (options.allowAiEdit === false) {
        return {
          ok: false,
          error: `AI file edits are disabled in Settings. Cannot overwrite '${existing.filename}'.`,
        };
      }
      if (existing.lockedByUser) {
        return {
          ok: false,
          error: `File '${existing.filename}' is locked against LLM edits in the Files tab.`,
        };
      }
    }

    const updated: WorkspaceFile = {
      ...existing,
      filename,
      title: input.title?.trim() ? title : existing.title || title,
      language,
      content: input.content,
      sizeBytes,
      updatedAt: now,
      lockedByUser: input.lockedByUser ?? existing.lockedByUser,
      source: input.source,
    };

    const nextFiles = files.map((f, idx) => (idx === existingIdx ? updated : f));
    return {
      ok: true,
      file: updated,
      files: nextFiles,
      action: 'updated',
    };
  }

  const created: WorkspaceFile = {
    id: `wfile_${createId().slice(0, 8)}`,
    filename,
    title,
    language,
    content: input.content,
    sizeBytes,
    createdAt: now,
    updatedAt: now,
    lockedByUser: input.lockedByUser ?? false,
    source: input.source,
  };

  return {
    ok: true,
    file: created,
    files: [created, ...files],
    action: 'created',
  };
}

export function workspaceFileToArtifact(file: WorkspaceFile): GeneratedFileArtifact {
  return {
    id: file.id,
    filename: file.filename,
    title: file.title,
    language: file.language,
    content: file.content,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    isEdited: file.updatedAt > file.createdAt,
  };
}

/**
 * Formats a compact catalog of persistent Files-tab files so low-context models
 * know what local files exist across sessions without injecting full file contents.
 */
export function formatWorkspaceFilesCatalogForPrompt(
  files: WorkspaceFile[],
  allowAiFileEdits: boolean,
): string {
  const sections: string[] = [];
  if (!allowAiFileEdits) {
    sections.push(
      '[File Edit Policy]\nAI file edits are disabled by user Settings. Do NOT attempt to modify or overwrite existing files; read-only inspection is allowed.',
    );
  }
  if (files.length > 0) {
    const entries = files.map((f) => {
      const lines = countLines(f.content);
      const size = formatWorkspaceFileSize(f.sizeBytes);
      const lockStatus = f.lockedByUser || !allowAiFileEdits ? 'read-only/locked' : 'editable';
      return `- ${f.filename} (${f.language}, ${lines} lines, ${size}, ${lockStatus})`;
    });
    sections.push(
      `[Local Files Tab (persistent across all chats)]\n${entries.join('\n')}\nUse \`read_attached_chunk(filename="...", start_line=1, end_line=120)\` to inspect any file on demand.`,
    );
  }
  return sections.join('\n\n');
}
