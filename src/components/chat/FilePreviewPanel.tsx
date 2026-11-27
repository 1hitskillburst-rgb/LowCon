import React, { useMemo, useState } from 'react';
import {
  BookmarkPlus,
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  FileText,
  Globe,
  Image,
  Lock,
  LockOpen,
  Table2,
  X,
} from 'lucide-react';
import { detectArtifactPreviewKind, type ArtifactPreviewKind } from '../../core/artifactPreview';
import { countLines, getFileExtensionBadge } from '../../core/tools';
import type { GeneratedFileArtifact } from '../../core/types';
import { highlightCodeHtml } from './MarkdownMessage';
import { RichArtifactPreview } from './RichArtifactPreview';

interface FilePreviewPanelProps {
  file: GeneratedFileArtifact;
  onClose: () => void;
  isInWorkspaceFiles?: boolean;
  isLockedInWorkspace?: boolean;
  onToggleWorkspaceLock?: () => void;
  onSaveToWorkspaceFiles?: () => void;
}

function renderKindIcon(kind: ArtifactPreviewKind): React.ReactNode {
  switch (kind) {
    case 'markdown':
      return <FileText className="h-4 w-4 shrink-0 text-[var(--lc-accent)]" />;
    case 'csv':
      return <Table2 className="h-4 w-4 shrink-0 text-[var(--lc-accent)]" />;
    case 'svg':
      return <Image className="h-4 w-4 shrink-0 text-[var(--lc-accent)]" />;
    case 'html':
      return <Globe className="h-4 w-4 shrink-0 text-[var(--lc-accent)]" />;
    case 'code':
      return <Code2 className="h-4 w-4 shrink-0 text-[var(--lc-accent)]" />;
  }
}

export const FilePreviewPanel: React.FC<FilePreviewPanelProps> = ({
  file,
  onClose,
  isInWorkspaceFiles = false,
  isLockedInWorkspace = false,
  onToggleWorkspaceLock,
  onSaveToWorkspaceFiles,
}) => {
  const [copied, setCopied] = useState(false);
  const [viewModeOverride, setViewModeOverride] = useState<{
    fileId: string;
    mode: 'preview' | 'code';
  } | null>(null);

  const previewKind = useMemo(
    () => detectArtifactPreviewKind(file.filename, file.language),
    [file.filename, file.language],
  );
  const isRichFormat = previewKind !== 'code';
  const activeViewMode: 'preview' | 'code' = !isRichFormat
    ? 'code'
    : viewModeOverride && viewModeOverride.fileId === file.id
      ? viewModeOverride.mode
      : 'preview';

  const lineCount = useMemo(() => countLines(file.content), [file.content]);
  const extBadge = useMemo(
    () => getFileExtensionBadge(file.filename, file.language),
    [file.filename, file.language],
  );
  const { html } = useMemo(
    () => highlightCodeHtml(file.content, file.language),
    [file.content, file.language],
  );
  const lineNumbers = useMemo(
    () => Array.from({ length: Math.max(1, lineCount) }, (_, idx) => idx + 1),
    [lineCount],
  );

  const handleCopy = () => {
    void navigator.clipboard?.writeText(file.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const handleDownload = () => {
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
    <aside
      aria-label={`File preview: ${file.filename}`}
      data-testid="file-preview-panel"
      className="flex h-full w-[46%] min-w-[380px] max-w-[740px] shrink-0 flex-col border-l border-[var(--lc-line)] bg-[var(--lc-code-bg)] text-[var(--lc-code-text)]"
    >
      {/* Top Preview Header */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--lc-code-border)] bg-[var(--lc-code-header)] px-3.5 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {renderKindIcon(previewKind)}
          <span className="truncate font-mono text-[13px] font-semibold text-[var(--lc-code-text)]">
            {file.filename}
          </span>
          <span className="shrink-0 rounded-[5px] border border-[var(--lc-code-border)] bg-[var(--lc-code-bg)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--lc-code-mute)]">
            {extBadge} · {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
          {file.isEdited && (
            <span
              data-testid="file-preview-edited-badge"
              className="shrink-0 rounded-[5px] border border-[var(--lc-accent)]/35 bg-[var(--lc-accent)]/12 px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--lc-accent)]"
            >
              Edited
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {onToggleWorkspaceLock ? (
            <button
              type="button"
              onClick={onToggleWorkspaceLock}
              data-testid="file-preview-lock-toggle"
              className={`inline-flex items-center gap-1 rounded-[6px] border px-2 py-1 text-[11.5px] font-medium transition-colors ${
                isLockedInWorkspace
                  ? 'border-[var(--lc-warn)]/45 bg-[var(--lc-warn)]/12 text-[var(--lc-warn)]'
                  : 'border-[var(--lc-code-border)] bg-[var(--lc-code-bg)] text-[var(--lc-code-mute)] hover:text-[var(--lc-code-text)]'
              }`}
              title={
                isLockedInWorkspace
                  ? 'Locked against LLM edits (click to unlock)'
                  : 'LLMs can edit this file (click to lock)'
              }
            >
              {isLockedInWorkspace ? (
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
          ) : (
            onSaveToWorkspaceFiles && (
              <button
                type="button"
                onClick={onSaveToWorkspaceFiles}
                data-testid="file-preview-save-workspace"
                className={`inline-flex items-center gap-1 rounded-[6px] border px-2 py-1 text-[11.5px] font-medium transition-colors ${
                  isInWorkspaceFiles
                    ? 'border-[var(--lc-success)]/40 bg-[var(--lc-success)]/12 text-[var(--lc-success)]'
                    : 'border-[var(--lc-code-border)] bg-[var(--lc-code-bg)] text-[var(--lc-code-text)] hover:bg-[var(--lc-hover)]'
                }`}
                title="Store in the persistent Files tab across chats"
              >
                {isInWorkspaceFiles ? (
                  <>
                    <Check className="h-3 w-3" />
                    <span>In Files</span>
                  </>
                ) : (
                  <>
                    <BookmarkPlus className="h-3 w-3" />
                    <span>Save to Files</span>
                  </>
                )}
              </button>
            )
          )}

          {isRichFormat && (
            <div
              role="group"
              aria-label="Preview mode"
              data-testid="file-preview-mode-toggle"
              className="inline-flex items-center rounded-[6px] border border-[var(--lc-code-border)] bg-[var(--lc-code-bg)] p-0.5"
            >
              <button
                type="button"
                data-testid="file-preview-mode-preview"
                aria-pressed={activeViewMode === 'preview'}
                onClick={() => setViewModeOverride({ fileId: file.id, mode: 'preview' })}
                className={`inline-flex items-center gap-1 rounded-[4px] px-2 py-0.5 text-[11.5px] font-medium transition-colors ${
                  activeViewMode === 'preview'
                    ? 'bg-[var(--lc-active-pill-bg)] text-[var(--lc-active-pill-fg)]'
                    : 'text-[var(--lc-code-mute)] hover:text-[var(--lc-code-text)]'
                }`}
              >
                <Eye className="h-3 w-3" />
                <span>Preview</span>
              </button>
              <button
                type="button"
                data-testid="file-preview-mode-code"
                aria-pressed={activeViewMode === 'code'}
                onClick={() => setViewModeOverride({ fileId: file.id, mode: 'code' })}
                className={`inline-flex items-center gap-1 rounded-[4px] px-2 py-0.5 text-[11.5px] font-medium transition-colors ${
                  activeViewMode === 'code'
                    ? 'bg-[var(--lc-active-pill-bg)] text-[var(--lc-active-pill-fg)]'
                    : 'text-[var(--lc-code-mute)] hover:text-[var(--lc-code-text)]'
                }`}
              >
                <Code2 className="h-3 w-3" />
                <span>Code</span>
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={handleCopy}
            data-testid="file-preview-copy"
            className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--lc-code-border)] bg-[var(--lc-code-bg)] px-2.5 py-1 text-[12px] font-medium text-[var(--lc-code-text)] transition-colors hover:bg-[var(--lc-hover)]"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-[var(--lc-success)]" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5 text-[var(--lc-code-mute)]" />
                <span>Copy</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleDownload}
            title={`Download ${file.filename}`}
            aria-label={`Download ${file.filename}`}
            data-testid="file-preview-download"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] border border-[var(--lc-code-border)] bg-[var(--lc-code-bg)] text-[var(--lc-code-mute)] transition-colors hover:bg-[var(--lc-hover)] hover:text-[var(--lc-code-text)]"
          >
            <Download className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={onClose}
            title="Close file preview"
            aria-label="Close file preview"
            data-testid="file-preview-close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--lc-code-mute)] transition-colors hover:bg-[var(--lc-hover)] hover:text-[var(--lc-code-text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Rich Preview or Line-numbered Syntax-Highlighted Code */}
      {isRichFormat && activeViewMode === 'preview' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <RichArtifactPreview file={file} kind={previewKind} />
        </div>
      ) : (
        <div data-testid="file-preview-code-view" className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-h-full min-w-max items-stretch">
            <div
              aria-hidden="true"
              className="select-none border-r border-[var(--lc-code-border)] bg-[var(--lc-code-header)]/55 px-3 py-3 text-right font-mono text-[12.5px] leading-[20px] text-[var(--lc-code-mute)] tabular-nums"
            >
              {lineNumbers.map((num) => (
                <div key={num}>{num}</div>
              ))}
            </div>
            <pre className="flex-1 py-3 pr-5 pl-4 font-mono text-[12.5px] leading-[20px]">
              <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
            </pre>
          </div>
        </div>
      )}
    </aside>
  );
};
