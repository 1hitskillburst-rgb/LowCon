import React, { useMemo, useState } from 'react';
import { Check, Code2, Copy, Download, X } from 'lucide-react';
import { countLines, getFileExtensionBadge } from '../../core/tools';
import type { GeneratedFileArtifact } from '../../core/types';
import { highlightCodeHtml } from './MarkdownMessage';

interface FilePreviewPanelProps {
  file: GeneratedFileArtifact;
  onClose: () => void;
}

export const FilePreviewPanel: React.FC<FilePreviewPanelProps> = ({ file, onClose }) => {
  const [copied, setCopied] = useState(false);

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
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--lc-code-border)] bg-[var(--lc-code-header)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Code2 className="h-4 w-4 shrink-0 text-[var(--lc-accent)]" />
          <span className="truncate font-mono text-[13px] font-semibold text-[var(--lc-code-text)]">
            {file.filename}
          </span>
          <span className="shrink-0 rounded-[5px] border border-[var(--lc-code-border)] bg-[var(--lc-code-bg)] px-1.5 py-0.5 text-[10.5px] font-semibold text-[var(--lc-code-mute)]">
            {extBadge} · {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
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

      {/* Line-numbered Syntax-Highlighted Code */}
      <div className="min-h-0 flex-1 overflow-auto">
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
    </aside>
  );
};
