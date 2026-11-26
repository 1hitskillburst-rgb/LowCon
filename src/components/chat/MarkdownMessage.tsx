import React, { useMemo, useState } from 'react';
import katex from 'katex';
import hljs from 'highlight.js/lib/common';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  Flame,
  Info,
  Lightbulb,
} from 'lucide-react';
import {
  parseInlineTokens,
  parseMarkdownBlocks,
  type CalloutKind,
  type InlineToken,
  type ListBlock,
  type MarkdownBlock,
} from '../../core/markdown';

interface MarkdownMessageProps {
  content: string;
  compact?: boolean;
}

const CALLOUT_STYLES: Record<
  CalloutKind,
  { border: string; bg: string; title: string; icon: React.ReactNode }
> = {
  note: {
    border: 'border-[#2A3FE0]',
    bg: 'bg-[#2A3FE0]/6',
    title: 'text-[#2A3FE0]',
    icon: <Info className="h-3.5 w-3.5 shrink-0" />,
  },
  tip: {
    border: 'border-[#1D7A4E]',
    bg: 'bg-[#1D7A4E]/7',
    title: 'text-[#1D7A4E]',
    icon: <Lightbulb className="h-3.5 w-3.5 shrink-0" />,
  },
  important: {
    border: 'border-[#7C3AED]',
    bg: 'bg-[#7C3AED]/7',
    title: 'text-[#6D28D9]',
    icon: <AlertCircle className="h-3.5 w-3.5 shrink-0" />,
  },
  warning: {
    border: 'border-[#B45309]',
    bg: 'bg-[#F59E0B]/10',
    title: 'text-[#B45309]',
    icon: <AlertTriangle className="h-3.5 w-3.5 shrink-0" />,
  },
  caution: {
    border: 'border-[#D9383A]',
    bg: 'bg-[#D9383A]/7',
    title: 'text-[#D9383A]',
    icon: <Flame className="h-3.5 w-3.5 shrink-0" />,
  },
};

function renderKatexHtml(expr: string, displayMode: boolean): string {
  return katex.renderToString(expr, {
    displayMode,
    throwOnError: false,
    strict: false,
    output: 'htmlAndMathml',
  });
}

export function highlightCodeHtml(code: string, lang: string): { html: string; detectedLang: string } {
  const normalizedLang = lang.trim().toLowerCase();
  if (normalizedLang && hljs.getLanguage(normalizedLang)) {
    const result = hljs.highlight(code, { language: normalizedLang, ignoreIllegals: true });
    return { html: result.value, detectedLang: normalizedLang };
  }
  if (!normalizedLang && code.trim().length >= 12) {
    const auto = hljs.highlightAuto(code);
    return { html: auto.value, detectedLang: auto.language ?? 'text' };
  }
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return { html: escaped, detectedLang: normalizedLang || 'text' };
}

const CodeBlockView: React.FC<{ lang: string; code: string; closed: boolean; compact?: boolean }> = ({
  lang,
  code,
  closed,
  compact,
}) => {
  const [copied, setCopied] = useState(false);
  const { html, detectedLang } = useMemo(() => highlightCodeHtml(code, lang), [code, lang]);

  return (
    <div className="my-2 overflow-hidden rounded-[8px] border border-[var(--lc-code-border)] bg-[var(--lc-code-bg)] text-[var(--lc-code-text)]">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--lc-code-border)] bg-[var(--lc-code-header)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11.5px] font-semibold tracking-wide text-[var(--lc-code-mute)] uppercase">
            {detectedLang}
          </span>
          {!closed && (
            <span className="rounded bg-[var(--lc-accent)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--lc-accent)]">
              streaming
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[11.5px] text-[var(--lc-code-mute)] transition-colors hover:bg-[var(--lc-hover)] hover:text-[var(--lc-code-text)]"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-[var(--lc-success)]" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre
        className={`overflow-x-auto px-3.5 py-3 font-mono leading-relaxed ${
          compact ? 'text-[12px]' : 'text-[13px]'
        }`}
      >
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
};

function renderInlineTokens(tokens: InlineToken[], keyPrefix: string): React.ReactNode[] {
  return tokens.map((token, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (token.type) {
      case 'text':
        return <React.Fragment key={key}>{token.text}</React.Fragment>;
      case 'br':
        return <br key={key} />;
      case 'code':
        return (
          <code
            key={key}
            className="rounded-[4px] border border-[var(--lc-line)] bg-[var(--lc-inline-code-bg)] px-1.5 py-[1px] font-mono text-[0.88em] text-[var(--lc-ink)]"
          >
            {token.code}
          </code>
        );
      case 'math':
        return (
          <span
            key={key}
            className="inline-block align-middle"
            dangerouslySetInnerHTML={{ __html: renderKatexHtml(token.expr, false) }}
          />
        );
      case 'bold':
        return (
          <strong key={key} className="font-semibold text-[var(--lc-ink)]">
            {renderInlineTokens(token.children, key)}
          </strong>
        );
      case 'italic':
        return (
          <em key={key} className="italic">
            {renderInlineTokens(token.children, key)}
          </em>
        );
      case 'bold_italic':
        return (
          <strong key={key} className="font-semibold italic text-[var(--lc-ink)]">
            {renderInlineTokens(token.children, key)}
          </strong>
        );
      case 'strike':
        return (
          <del key={key} className="text-[var(--lc-mute)] line-through">
            {renderInlineTokens(token.children, key)}
          </del>
        );
      case 'kbd':
        return (
          <kbd
            key={key}
            className="rounded-[4px] border border-[var(--lc-line)] bg-[var(--lc-bg)] px-1.5 py-0.5 font-mono text-[0.82em] font-semibold text-[var(--lc-ink)] shadow-[0_1px_0_var(--lc-line)]"
          >
            {token.text}
          </kbd>
        );
      case 'link':
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--lc-accent)] underline decoration-[var(--lc-accent)]/40 underline-offset-2 hover:decoration-[var(--lc-accent)]"
          >
            {renderInlineTokens(token.label, key)}
          </a>
        );
    }
  });
}

function renderInline(text: string, keyPrefix: string): React.ReactNode {
  return renderInlineTokens(parseInlineTokens(text), keyPrefix);
}

const HEADING_CLASSES: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: 'mt-3 mb-1.5 text-[21px] font-bold tracking-tight text-[var(--lc-ink)]',
  2: 'mt-3 mb-1.5 text-[18px] font-bold tracking-tight text-[var(--lc-ink)]',
  3: 'mt-2.5 mb-1 text-[16px] font-semibold text-[var(--lc-ink)]',
  4: 'mt-2 mb-1 text-[15px] font-semibold text-[var(--lc-ink)]',
  5: 'mt-2 mb-1 text-[14px] font-semibold text-[var(--lc-ink2)]',
  6: 'mt-2 mb-1 text-[13px] font-semibold uppercase tracking-wide text-[var(--lc-ink2)]',
};

const ALIGN_CLASS: Record<'left' | 'center' | 'right', string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

function renderList(list: ListBlock, keyPrefix: string): React.ReactNode {
  const Tag = list.ordered ? 'ol' : 'ul';
  const listClass = list.ordered
    ? 'list-decimal space-y-1 pl-6'
    : 'list-disc space-y-1 pl-5';

  return (
    <Tag key={keyPrefix} start={list.ordered ? list.start : undefined} className={listClass}>
      {list.items.map((item, idx) => {
        const itemKey = `${keyPrefix}-li-${idx}`;
        const hasCheckbox = typeof item.checked === 'boolean';
        return (
          <li key={itemKey} className={hasCheckbox ? 'list-none -ml-4 flex items-start gap-2' : ''}>
            {hasCheckbox && (
              <input
                type="checkbox"
                checked={item.checked}
                readOnly
                aria-label={item.checked ? 'Completed item' : 'Incomplete item'}
                className="mt-1 h-3.5 w-3.5 shrink-0 rounded border-[#C3CAD4] accent-[#2A3FE0]"
              />
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <div>{renderInline(item.text, itemKey)}</div>
              {item.children?.map((child, childIdx) =>
                renderList(child, `${itemKey}-child-${childIdx}`),
              )}
            </div>
          </li>
        );
      })}
    </Tag>
  );
}

function renderBlocks(blocks: MarkdownBlock[], keyPrefix: string, compact?: boolean): React.ReactNode {
  return blocks.map((block, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (block.type) {
      case 'heading': {
        const HeadingTag = `h${block.depth}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        return (
          <HeadingTag key={key} className={HEADING_CLASSES[block.depth]}>
            {renderInline(block.text, key)}
          </HeadingTag>
        );
      }
      case 'code':
        return (
          <CodeBlockView
            key={key}
            lang={block.lang}
            code={block.code}
            closed={block.closed}
            compact={compact}
          />
        );
      case 'math':
        return (
          <div
            key={key}
            data-testid="math-block"
            className="my-2 overflow-x-auto rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3.5 py-2.5 text-center text-[var(--lc-surf-ink)]"
            dangerouslySetInnerHTML={{ __html: renderKatexHtml(block.expr, true) }}
          />
        );
      case 'hr':
        return <hr key={key} className="my-3 border-t border-[var(--lc-line)]" />;
      case 'blockquote':
        return (
          <blockquote
            key={key}
            className="my-2 space-y-1.5 border-l-[3px] border-[var(--lc-line)] pl-3.5 text-[var(--lc-ink2)]"
          >
            {renderBlocks(block.blocks, key, compact)}
          </blockquote>
        );
      case 'callout': {
        const style = CALLOUT_STYLES[block.kind];
        return (
          <div
            key={key}
            className={`my-2 rounded-[8px] border-l-[3px] ${style.border} ${style.bg} px-3.5 py-2.5`}
          >
            <div className={`mb-1 flex items-center gap-1.5 text-[12.5px] font-semibold ${style.title}`}>
              {style.icon}
              <span>{block.title}</span>
            </div>
            <div className="space-y-1.5 text-[14px] text-[var(--lc-ink)]">
              {renderBlocks(block.blocks, key, compact)}
            </div>
          </div>
        );
      }
      case 'table':
        return (
          <div key={key} className="my-2 overflow-x-auto rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)]">
            <table className="w-full border-collapse text-left text-[13.5px]">
              <thead className="border-b border-[var(--lc-surf-line)] bg-[var(--lc-panel)]">
                <tr>
                  {block.headers.map((header, hIdx) => {
                    const align = block.alignments[hIdx];
                    return (
                      <th
                        key={`${key}-th-${hIdx}`}
                        className={`px-3 py-2 font-semibold text-[var(--lc-side-ink)] ${
                          align ? ALIGN_CLASS[align] : 'text-left'
                        }`}
                      >
                        {renderInline(header, `${key}-th-${hIdx}`)}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--lc-line-soft)]">
                {block.rows.map((row, rIdx) => (
                  <tr key={`${key}-tr-${rIdx}`} className="hover:bg-[var(--lc-surf-hover)]/45">
                    {row.map((cell, cIdx) => {
                      const align = block.alignments[cIdx];
                      return (
                        <td
                          key={`${key}-td-${rIdx}-${cIdx}`}
                          className={`px-3 py-2 text-[var(--lc-surf-ink)] ${
                            align ? ALIGN_CLASS[align] : 'text-left'
                          }`}
                        >
                          {renderInline(cell, `${key}-td-${rIdx}-${cIdx}`)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'list':
        return renderList(block, key);
      case 'details':
        return (
          <details
            key={key}
            className="my-2 rounded-[8px] border border-[var(--lc-surf-line)] bg-[var(--lc-surface)] px-3.5 py-2 text-[var(--lc-surf-ink)]"
          >
            <summary className="cursor-pointer text-[13.5px] font-semibold text-[var(--lc-surf-ink)]">
              {renderInline(block.summary, `${key}-summary`)}
            </summary>
            <div className="mt-2 space-y-2 border-t border-[var(--lc-line-soft)] pt-2 text-[14px]">
              {renderBlocks(block.blocks, `${key}-body`, compact)}
            </div>
          </details>
        );
      case 'paragraph':
        return (
          <p key={key} className="leading-relaxed">
            {renderInline(block.text, key)}
          </p>
        );
    }
  });
}

export const MarkdownMessage: React.FC<MarkdownMessageProps> = ({ content, compact }) => {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);

  return (
    <div
      data-testid={compact ? 'markdown-compact' : 'markdown-message'}
      className={
        compact
          ? 'space-y-2 text-[12.5px] leading-relaxed break-words text-[var(--lc-ink2)]'
          : 'space-y-2.5 text-[15.5px] leading-relaxed break-words text-[var(--lc-ink)]'
      }
    >
      {renderBlocks(blocks, 'md', compact)}
    </div>
  );
};
