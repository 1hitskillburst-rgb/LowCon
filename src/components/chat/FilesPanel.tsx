import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Download,
  Eye,
  FolderOpen,
  Lock,
  LockOpen,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { formatRelativeTime } from '../../core/privacy';
import { countLines } from '../../core/tools';
import type { WorkspaceFile } from '../../core/types';
import {
  DEFAULT_SORT_DIRECTIONS,
  filterAndSortWorkspaceFiles,
  formatWorkspaceFileSize,
  getWorkspaceFileExtension,
  MAX_WORKSPACE_FILE_BYTES,
  type SortDirection,
  type WorkspaceFileSortField,
} from '../../core/workspaceFiles';

interface FilesPanelProps {
  files: WorkspaceFile[];
  allowAiFileEdits: boolean;
  onUploadFiles: (items: Array<{ filename: string; content: string }>) => void;
  onToggleFileLock: (fileId: string, locked: boolean) => void;
  onDeleteFile: (fileId: string) => void;
  onPreviewFile: (file: WorkspaceFile) => void;
  onOpenFileSettings?: () => void;
}

const SORT_LABELS: Record<WorkspaceFileSortField, string> = {
  updatedAt: 'Date modified',
  createdAt: 'Date created',
  name: 'Name',
  type: 'File type',
  size: 'Size',
};

const SOURCE_LABELS: Record<WorkspaceFile['source'], string> = {
  upload: 'Uploaded',
  chat: 'Saved from chat',
  ai: 'Saved by AI',
};

export const FilesPanel: React.FC<FilesPanelProps> = ({
  files,
  allowAiFileEdits,
  onUploadFiles,
  onToggleFileLock,
  onDeleteFile,
  onPreviewFile,
  onOpenFileSettings,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<WorkspaceFileSortField>('updatedAt');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const visibleFiles = useMemo(
    () => filterAndSortWorkspaceFiles(files, searchQuery, sortBy, sortDir),
    [files, searchQuery, sortBy, sortDir],
  );

  const totalBytes = useMemo(
    () => files.reduce((sum, f) => sum + f.sizeBytes, 0),
    [files],
  );

  const ingestFileList = async (list: FileList | null) => {
    setUploadError(null);
    if (!list || list.length === 0) return;
    const accepted: Array<{ filename: string; content: string }> = [];
    const rejected: string[] = [];

    for (const file of Array.from(list)) {
      if (file.size > MAX_WORKSPACE_FILE_BYTES) {
        rejected.push(`${file.name} (> ${Math.round(MAX_WORKSPACE_FILE_BYTES / 1024)} KB)`);
        continue;
      }
      try {
        const content = await file.text();
        accepted.push({ filename: file.name, content });
      } catch {
        rejected.push(`${file.name} (unreadable)`);
      }
    }

    if (accepted.length > 0) {
      onUploadFiles(accepted);
    }
    if (rejected.length > 0) {
      setUploadError(`Skipped: ${rejected.join(', ')}`);
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await ingestFileList(e.target.files);
    e.target.value = '';
  };

  const handleSortFieldChange = (nextField: WorkspaceFileSortField) => {
    setSortBy(nextField);
    setSortDir(DEFAULT_SORT_DIRECTIONS[nextField]);
  };

  const handleDownloadFile = (file: WorkspaceFile) => {
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      data-testid="files-panel"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        void ingestFileList(e.dataTransfer.files);
      }}
      className={`flex min-h-0 flex-1 flex-col overflow-y-auto px-[22px] pt-4 pb-6 transition-colors ${
        isDragOver ? 'bg-[var(--lc-accent)]/6' : ''
      }`}
    >
      {/* Header & Upload */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold text-[var(--lc-side-ink)]">Local Files</h2>
          <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--lc-side-mute)]">
            {files.length === 0
              ? 'Persistent across all chats'
              : `${files.length} ${files.length === 1 ? 'file' : 'files'} · ${formatWorkspaceFileSize(totalBytes)}`}
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          data-testid="files-upload-input"
          onChange={(e) => void handleFileInputChange(e)}
          className="hidden"
          accept=".txt,.md,.markdown,.json,.csv,.tsv,.rs,.ts,.tsx,.js,.jsx,.py,.go,.c,.cpp,.h,.hpp,.html,.htm,.css,.yaml,.yml,.toml,.xml,.svg,.sh,.sql,.log,.ini,.env,.cfg"
        />
        <button
          type="button"
          data-testid="files-upload-button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[7px] bg-[var(--lc-accent)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--lc-accent-contrast)] transition-colors hover:bg-[var(--lc-accent-hover)]"
        >
          <Upload className="h-3.5 w-3.5" />
          <span>Upload</span>
        </button>
      </div>

      {/* Global Edit Disabled Notice */}
      {!allowAiFileEdits && (
        <div
          data-testid="files-global-edits-disabled-banner"
          className="mt-3 flex items-center justify-between gap-2 rounded-[7px] border border-[var(--lc-warn)]/40 bg-[var(--lc-warn)]/10 px-2.5 py-2 text-[11.5px] text-[var(--lc-warn)]"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            <span>AI edits disabled overall</span>
          </span>
          {onOpenFileSettings && (
            <button
              type="button"
              onClick={onOpenFileSettings}
              className="shrink-0 font-semibold underline hover:opacity-80"
            >
              Settings
            </button>
          )}
        </div>
      )}

      {uploadError && (
        <div
          role="alert"
          className="mt-2.5 flex items-center justify-between gap-2 rounded-[6px] border border-[var(--lc-danger)]/40 bg-[var(--lc-danger)]/10 px-2.5 py-1.5 text-[11.5px] text-[var(--lc-danger)]"
        >
          <span className="truncate">{uploadError}</span>
          <button
            type="button"
            onClick={() => setUploadError(null)}
            aria-label="Dismiss upload warning"
            className="shrink-0 rounded p-0.5 hover:bg-[var(--lc-danger)]/15"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Name Search */}
      <div className="relative mt-3">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--lc-surf-mute)]" />
        <label htmlFor="files-search-input" className="sr-only">
          Search local files by name
        </label>
        <input
          id="files-search-input"
          data-testid="files-search-input"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search files by name..."
          className="w-full rounded-[7px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] py-1.5 pr-7 pl-8 text-[12.5px] text-[var(--lc-surf-ink)] placeholder:text-[var(--lc-surf-mute)] focus:border-[var(--lc-accent)] focus:outline-none"
        />
        {searchQuery && (
          <button
            type="button"
            aria-label="Clear file search"
            onClick={() => setSearchQuery('')}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-[var(--lc-surf-mute)] hover:text-[var(--lc-surf-ink)]"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Sort Bar */}
      <div className="mt-2 flex items-center gap-1.5">
        <label htmlFor="files-sort-select" className="text-[11.5px] text-[var(--lc-side-mute)]">
          Sort:
        </label>
        <select
          id="files-sort-select"
          data-testid="files-sort-select"
          value={sortBy}
          onChange={(e) => handleSortFieldChange(e.target.value as WorkspaceFileSortField)}
          className="min-w-0 flex-1 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-2 py-1 text-[12px] text-[var(--lc-surf-ink)] focus:border-[var(--lc-accent)] focus:outline-none"
        >
          {(Object.keys(SORT_LABELS) as WorkspaceFileSortField[]).map((field) => (
            <option key={field} value={field}>
              {SORT_LABELS[field]}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="files-sort-dir"
          aria-label={`Sort direction: ${sortDir === 'asc' ? 'ascending' : 'descending'}`}
          title={sortDir === 'asc' ? 'Ascending (click to reverse)' : 'Descending (click to reverse)'}
          onClick={() => setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
          className="inline-flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] text-[var(--lc-surf-ink2)] hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)]"
        >
          {sortDir === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Files List */}
      <div className="mt-3.5 space-y-2">
        {files.length === 0 ? (
          <div className="rounded-[8px] border border-dashed border-[var(--lc-surf-line)] bg-[var(--lc-surface)]/75 px-3.5 py-5 text-center">
            <FolderOpen className="mx-auto h-5 w-5 text-[var(--lc-surf-mute)]" />
            <p className="mt-2 text-[12.5px] font-medium text-[var(--lc-surf-ink)]">
              No saved workspace files yet
            </p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--lc-surf-mute)]">
              Upload files here or tell the model in chat to remember a file—models can reference
              them in any session without re-uploading.
            </p>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3.5 py-5 text-center text-[12px] text-[var(--lc-surf-mute)]">
            No files match &ldquo;{searchQuery}&rdquo;.
          </div>
        ) : (
          visibleFiles.map((file) => {
            const ext = getWorkspaceFileExtension(file);
            const lines = countLines(file.content);
            return (
              <div
                key={file.id}
                data-testid={`workspace-file-${file.filename}`}
                className="rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-2.5 text-[var(--lc-surf-ink)] transition-colors hover:border-[var(--lc-accent)]/45"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onPreviewFile(file)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-85"
                    title={`Open ${file.filename}`}
                  >
                    <span className="shrink-0 rounded-[4px] border border-[var(--lc-surf-line)] bg-[var(--lc-panel)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--lc-side-ink2)]">
                      {ext}
                    </span>
                    <span className="truncate font-mono text-[12.5px] font-semibold text-[var(--lc-surf-ink)]">
                      {file.filename}
                    </span>
                  </button>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={file.lockedByUser}
                    data-testid={`file-lock-toggle-${file.filename}`}
                    onClick={() => onToggleFileLock(file.id, !file.lockedByUser)}
                    title={
                      file.lockedByUser
                        ? 'Locked: LLMs cannot edit this file (click to unlock)'
                        : 'Unlocked: LLMs can edit this file if global edits are enabled (click to lock)'
                    }
                    className={`inline-flex shrink-0 items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[10.5px] font-semibold transition-colors ${
                      file.lockedByUser
                        ? 'border-[var(--lc-warn)]/45 bg-[var(--lc-warn)]/12 text-[var(--lc-warn)]'
                        : 'border-[var(--lc-surf-line)] bg-[var(--lc-panel)]/70 text-[var(--lc-side-mute)] hover:text-[var(--lc-surf-ink)]'
                    }`}
                  >
                    {file.lockedByUser ? (
                      <>
                        <Lock className="h-3 w-3" />
                        <span>Locked</span>
                      </>
                    ) : (
                      <>
                        <LockOpen className="h-3 w-3" />
                        <span>Editable</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-[var(--lc-surf-mute)]">
                  <span className="truncate">
                    {lines} {lines === 1 ? 'line' : 'lines'} · {formatWorkspaceFileSize(file.sizeBytes)} ·{' '}
                    {formatRelativeTime(file.updatedAt)}
                  </span>
                </div>

                <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--lc-line-soft)] pt-1.5">
                  <span className="text-[10.5px] text-[var(--lc-side-mute)]">
                    {SOURCE_LABELS[file.source]}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onPreviewFile(file)}
                      aria-label={`Preview ${file.filename}`}
                      title="View file"
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--lc-surf-mute)] hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)]"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDownloadFile(file)}
                      aria-label={`Download ${file.filename}`}
                      title="Download file"
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--lc-surf-mute)] hover:bg-[var(--lc-surf-hover)] hover:text-[var(--lc-surf-ink)]"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteFile(file.id)}
                      data-testid={`file-delete-${file.filename}`}
                      aria-label={`Delete ${file.filename}`}
                      title="Remove from Files tab"
                      className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--lc-surf-mute)] hover:bg-[var(--lc-danger)]/10 hover:text-[var(--lc-danger)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
