import React, { useMemo, useState } from 'react';
import { AlertTriangle, FileWarning, Table2 } from 'lucide-react';
import {
  buildSandboxedHtmlSrcDoc,
  buildSvgDataUri,
  detectTableDelimiter,
  MAX_PREVIEW_TABLE_ROWS,
  parseDelimitedTable,
  type ArtifactPreviewKind,
} from '../../core/artifactPreview';
import type { GeneratedFileArtifact } from '../../core/types';
import { MarkdownMessage } from './MarkdownMessage';

export type RichArtifactPreviewKind = Exclude<ArtifactPreviewKind, 'code'>;

export interface RichArtifactPreviewProps {
  file: GeneratedFileArtifact;
  kind: RichArtifactPreviewKind;
}

const MarkdownPreview: React.FC<{ content: string }> = ({ content }) => {
  if (!content.trim()) {
    return (
      <div
        data-testid="rich-markdown-preview"
        className="flex h-full min-h-0 w-full items-center justify-center bg-[var(--lc-bg)] px-6 py-5 text-[13px] text-[var(--lc-mute)]"
      >
        Empty Markdown document
      </div>
    );
  }

  return (
    <div
      data-testid="rich-markdown-preview"
      className="h-full min-h-0 w-full overflow-auto bg-[var(--lc-bg)] px-6 py-5 text-[var(--lc-ink)]"
    >
      <MarkdownMessage content={content} />
    </div>
  );
};

const CsvPreview: React.FC<{ file: GeneratedFileArtifact }> = ({ file }) => {
  const delimiter = useMemo(
    () => detectTableDelimiter(file.filename, file.language),
    [file.filename, file.language],
  );
  const table = useMemo(
    () => parseDelimitedTable(file.content, delimiter),
    [file.content, delimiter],
  );

  const columnCount = useMemo(
    () => Math.max(table.headers.length, ...table.rows.map((row) => row.length)),
    [table.headers.length, table.rows],
  );

  if (columnCount === 0) {
    return (
      <div
        data-testid="rich-csv-preview"
        className="flex h-full min-h-0 w-full items-center justify-center bg-[var(--lc-surface)] px-6 py-5 text-[13px] text-[var(--lc-surf-mute)]"
      >
        No tabular data to display
      </div>
    );
  }

  return (
    <div
      data-testid="rich-csv-preview"
      className="flex h-full min-h-0 w-full flex-col bg-[var(--lc-surface)] text-[var(--lc-surf-ink)]"
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--lc-surf-line)] bg-[var(--lc-panel)] px-4 py-2 text-[12px] text-[var(--lc-side-ink2)]">
        <span className="inline-flex items-center gap-1.5 font-medium tabular-nums">
          <Table2 className="h-3.5 w-3.5 shrink-0 text-[var(--lc-accent)]" />
          <span>
            {table.rows.length} {table.rows.length === 1 ? 'row' : 'rows'} · {columnCount}{' '}
            {columnCount === 1 ? 'column' : 'columns'}
          </span>
        </span>
        {table.truncated && (
          <span
            data-testid="rich-csv-truncated-notice"
            className="inline-flex items-center gap-1 rounded-[5px] border border-[var(--lc-warn)]/35 bg-[var(--lc-warn)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--lc-warn)]"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>Showing first {MAX_PREVIEW_TABLE_ROWS} rows (truncated)</span>
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-[var(--lc-panel)] shadow-[inset_0_-1px_0_var(--lc-surf-line)]">
            <tr>
              {Array.from({ length: columnCount }, (_, colIdx) => {
                const header = table.headers[colIdx] ?? '';
                return (
                  <th
                    key={`th-${colIdx}`}
                    className="border-r border-[var(--lc-line-soft)] px-3 py-2 font-semibold whitespace-nowrap text-[var(--lc-side-ink)] last:border-r-0"
                  >
                    {header || (
                      <span className="font-normal italic text-[var(--lc-side-mute)]">(empty)</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--lc-line-soft)]">
            {table.rows.map((row, rowIdx) => (
              <tr key={`tr-${rowIdx}`} className="hover:bg-[var(--lc-surf-hover)]/45">
                {Array.from({ length: columnCount }, (_, colIdx) => (
                  <td
                    key={`td-${rowIdx}-${colIdx}`}
                    className="max-w-[320px] border-r border-[var(--lc-line-soft)] px-3 py-1.5 align-top break-words whitespace-pre-wrap text-[var(--lc-surf-ink)] last:border-r-0"
                  >
                    {row[colIdx] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

type SvgBackdropMode = 'checker' | 'light' | 'dark';

const SvgPreview: React.FC<{ file: GeneratedFileArtifact }> = ({ file }) => {
  const dataUri = useMemo(() => buildSvgDataUri(file.content), [file.content]);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const [backdrop, setBackdrop] = useState<SvgBackdropMode>('checker');

  const isInvalid = !dataUri || failedUri === dataUri;

  const canvasStyle: React.CSSProperties =
    backdrop === 'checker'
      ? {
          backgroundColor: 'var(--lc-surface)',
          backgroundImage:
            'linear-gradient(45deg, var(--lc-line-soft) 25%, transparent 25%), ' +
            'linear-gradient(-45deg, var(--lc-line-soft) 25%, transparent 25%), ' +
            'linear-gradient(45deg, transparent 75%, var(--lc-line-soft) 75%), ' +
            'linear-gradient(-45deg, transparent 75%, var(--lc-line-soft) 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
        }
      : backdrop === 'light'
        ? { backgroundColor: '#FFFFFF' }
        : { backgroundColor: '#11141A' };

  return (
    <div
      data-testid="rich-svg-preview"
      className="flex h-full min-h-0 w-full flex-col bg-[var(--lc-bg)] text-[var(--lc-ink)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--lc-surf-line)] bg-[var(--lc-panel)] px-4 py-1.5 text-[11.5px] text-[var(--lc-side-ink2)]">
        <span className="font-medium">Sanitized SVG preview</span>
        <div className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] p-0.5">
          {(['checker', 'light', 'dark'] as const).map((mode) => {
            const active = backdrop === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setBackdrop(mode)}
                className={`rounded-[4px] px-2 py-0.5 text-[11px] font-medium capitalize transition-colors ${
                  active
                    ? 'bg-[var(--lc-active-pill-bg)] text-[var(--lc-active-pill-fg)]'
                    : 'text-[var(--lc-surf-mute)] hover:text-[var(--lc-surf-ink)]'
                }`}
              >
                {mode}
              </button>
            );
          })}
        </div>
      </div>

      <div
        className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6"
        style={canvasStyle}
      >
        {isInvalid ? (
          <div className="flex flex-col items-center gap-2 rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-5 py-4 text-center text-[13px] text-[var(--lc-surf-ink2)]">
            <FileWarning className="h-5 w-5 text-[var(--lc-warn)]" />
            <span>Unable to render empty or invalid SVG markup.</span>
          </div>
        ) : (
          <img
            data-testid="rich-svg-image"
            src={dataUri}
            alt={file.title || file.filename}
            onError={() => setFailedUri(dataUri)}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>
    </div>
  );
};

const HtmlPreview: React.FC<{ file: GeneratedFileArtifact }> = ({ file }) => {
  const srcDoc = useMemo(() => buildSandboxedHtmlSrcDoc(file.content), [file.content]);

  return (
    <div data-testid="rich-html-preview" className="h-full min-h-0 w-full bg-white">
      <iframe
        data-testid="rich-html-iframe"
        title={file.title || file.filename}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="h-full w-full border-0 bg-white"
      />
    </div>
  );
};

export const RichArtifactPreview: React.FC<RichArtifactPreviewProps> = ({ file, kind }) => {
  switch (kind) {
    case 'markdown':
      return <MarkdownPreview content={file.content} />;
    case 'csv':
      return <CsvPreview file={file} />;
    case 'svg':
      return <SvgPreview file={file} />;
    case 'html':
      return <HtmlPreview file={file} />;
  }
};
