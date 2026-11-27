export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export type TableAlignment = 'left' | 'center' | 'right' | null;

export interface ListItemNode {
  text: string;
  checked?: boolean;
  children?: ListBlock[];
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  start: number;
  items: ListItemNode[];
}

export type MarkdownBlock =
  | { type: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: 'code'; lang: string; code: string; closed: boolean }
  | { type: 'math'; expr: string; closed: boolean }
  | { type: 'hr' }
  | { type: 'blockquote'; blocks: MarkdownBlock[] }
  | { type: 'callout'; kind: CalloutKind; title: string; blocks: MarkdownBlock[] }
  | {
      type: 'table';
      headers: string[];
      alignments: TableAlignment[];
      rows: string[][];
    }
  | ListBlock
  | { type: 'details'; summary: string; blocks: MarkdownBlock[] }
  | { type: 'paragraph'; text: string };

export type InlineToken =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string }
  | { type: 'math'; expr: string }
  | { type: 'bold'; children: InlineToken[] }
  | { type: 'italic'; children: InlineToken[] }
  | { type: 'bold_italic'; children: InlineToken[] }
  | { type: 'strike'; children: InlineToken[] }
  | { type: 'link'; label: InlineToken[]; href: string }
  | { type: 'image'; alt: string; src: string; isInlineSafe: boolean }
  | { type: 'kbd'; text: string }
  | { type: 'br' };

const CALLOUT_LABELS: Record<CalloutKind, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

export function sanitizeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;
  if (trimmed.startsWith('#') || trimmed.startsWith('/')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function sanitizeImageSrc(raw: string): { src: string; isInlineSafe: boolean } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;
  if (trimmed.startsWith('/')) {
    return { src: trimmed, isInlineSafe: true };
  }
  if (
    /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;|,)/i.test(
      trimmed,
    )
  ) {
    return { src: trimmed, isInlineSafe: true };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { src: parsed.toString(), isInlineSafe: false };
    }
    return null;
  } catch {
    return null;
  }
}

function findBalancedBracketEnd(input: string, openIdx: number): number {
  let depth = 0;
  let pos = openIdx;
  while (pos < input.length) {
    const c = input[pos];
    if (c === '\\') {
      pos += 2;
      continue;
    }
    if (c === '`') {
      let ticks = 0;
      while (pos + ticks < input.length && input[pos + ticks] === '`') ticks += 1;
      const closer = '`'.repeat(ticks);
      const end = input.indexOf(closer, pos + ticks);
      if (end !== -1) {
        pos = end + ticks;
        continue;
      }
    }
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) return pos;
    }
    pos += 1;
  }
  return -1;
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === '\\' && i + 1 < trimmed.length && trimmed[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '`') {
      inCode = !inCode;
      current += ch;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function parseTableSeparator(line: string): TableAlignment[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) return null;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return null;

  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) {
      return null;
    }
    if (cell.startsWith(':') && cell.endsWith(':')) {
      alignments.push('center');
    } else if (cell.endsWith(':')) {
      alignments.push('right');
    } else if (cell.startsWith(':')) {
      alignments.push('left');
    } else {
      alignments.push(null);
    }
  }
  return alignments;
}

function matchFenceOpen(line: string): { marker: '`' | '~'; count: number; lang: string } | null {
  const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const fence = match[1];
  const info = match[2].trim();
  const marker = fence[0] as '`' | '~';
  if (marker === '`' && info.includes('`')) return null;
  const lang = info.split(/\s+/)[0] ?? '';
  return { marker, count: fence.length, lang };
}

function isFenceClose(line: string, marker: '`' | '~', count: number): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== marker) return false;
  }
  return trimmed.length >= count;
}

function matchListLine(
  line: string,
): { indent: number; ordered: boolean; start: number; text: string; checked?: boolean } | null {
  const ulMatch = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (ulMatch) {
    const indent = ulMatch[1].replace(/\t/g, '  ').length;
    let body = ulMatch[3];
    let checked: boolean | undefined;
    const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(body);
    if (taskMatch) {
      checked = taskMatch[1].toLowerCase() === 'x';
      body = taskMatch[2];
    }
    return { indent, ordered: false, start: 1, text: body, checked };
  }

  const olMatch = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
  if (olMatch) {
    const indent = olMatch[1].replace(/\t/g, '  ').length;
    const start = Number.parseInt(olMatch[2], 10);
    return { indent, ordered: true, start, text: olMatch[3] };
  }

  return null;
}

function isBlockStarter(lines: string[], idx: number): boolean {
  const line = lines[idx];
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (matchFenceOpen(line)) return true;
  if (/^\s{0,3}#{1,6}(\s+|$)/.test(line)) return true;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return true;
  if (/^\s{0,3}>/.test(line)) return true;
  if (matchListLine(line)) return true;
  if (/^\s{0,3}(\$\$|\\\[)/.test(line)) return true;
  if (/^\s*<details(?:\s|>|$)/i.test(line)) return true;
  if (idx + 1 < lines.length && line.includes('|') && parseTableSeparator(lines[idx + 1])) {
    return true;
  }
  return false;
}

function parseList(lines: string[], startIdx: number, baseIndent: number): { block: ListBlock; nextIdx: number } {
  const first = matchListLine(lines[startIdx])!;
  const ordered = first.ordered;
  const start = first.start;
  const items: ListItemNode[] = [];
  let idx = startIdx;

  while (idx < lines.length) {
    const line = lines[idx];
    if (!line.trim()) {
      // Blank line ends list unless next non-blank line continues same list level
      let peek = idx + 1;
      while (peek < lines.length && !lines[peek].trim()) peek += 1;
      const nextList = peek < lines.length ? matchListLine(lines[peek]) : null;
      if (nextList && nextList.indent >= baseIndent) {
        idx = peek;
        continue;
      }
      break;
    }

    const match = matchListLine(line);
    if (!match) {
      // Continuation line indented under current item
      const lineIndent = /^(\s*)/.exec(line)?.[1].replace(/\t/g, '  ').length ?? 0;
      if (lineIndent > baseIndent && items.length > 0 && !isBlockStarter(lines, idx)) {
        items[items.length - 1].text += `\n${line.trim()}`;
        idx += 1;
        continue;
      }
      break;
    }

    if (match.indent < baseIndent) {
      break;
    }

    if (match.indent > baseIndent && items.length > 0) {
      const nested = parseList(lines, idx, match.indent);
      const lastItem = items[items.length - 1];
      lastItem.children = [...(lastItem.children ?? []), nested.block];
      idx = nested.nextIdx;
      continue;
    }

    if (match.ordered !== ordered) {
      break;
    }

    items.push({
      text: match.text,
      checked: match.checked,
    });
    idx += 1;
  }

  return {
    block: { type: 'list', ordered, start, items },
    nextIdx: idx,
  };
}

export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const normalized = input.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // 1. Fenced code block (``` or ~~~)
    const fence = matchFenceOpen(line);
    if (fence) {
      const codeLines: string[] = [];
      let closed = false;
      i += 1;
      while (i < lines.length) {
        if (isFenceClose(lines[i], fence.marker, fence.count)) {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      blocks.push({
        type: 'code',
        lang: fence.lang,
        code: codeLines.join('\n'),
        closed,
      });
      continue;
    }

    // 2. Display math block ($$ ... $$ or \[ ... \])
    const mathOpen = /^\s{0,3}(\$\$|\\\[)(.*)$/.exec(line);
    if (mathOpen) {
      const delimiter = mathOpen[1];
      const closeDelimiter = delimiter === '$$' ? '$$' : '\\]';
      const restOfFirstLine = mathOpen[2];
      const sameLineCloseIdx = restOfFirstLine.lastIndexOf(closeDelimiter);
      if (sameLineCloseIdx !== -1 && (delimiter === '\\[' || restOfFirstLine.trim().length > 0)) {
        const expr = restOfFirstLine.slice(0, sameLineCloseIdx).trim();
        const trailing = restOfFirstLine.slice(sameLineCloseIdx + closeDelimiter.length).trim();
        blocks.push({ type: 'math', expr, closed: true });
        i += 1;
        if (trailing) {
          blocks.push({ type: 'paragraph', text: trailing });
        }
        continue;
      }

      const exprLines: string[] = [];
      if (restOfFirstLine.trim()) {
        exprLines.push(restOfFirstLine);
      }
      let closed = false;
      i += 1;
      while (i < lines.length) {
        const current = lines[i];
        const closePos = current.indexOf(closeDelimiter);
        if (closePos !== -1) {
          const beforeClose = current.slice(0, closePos);
          if (beforeClose.trim()) {
            exprLines.push(beforeClose);
          }
          closed = true;
          i += 1;
          break;
        }
        exprLines.push(current);
        i += 1;
      }
      blocks.push({
        type: 'math',
        expr: exprLines.join('\n').trim(),
        closed,
      });
      continue;
    }

    // 3. Heading (# .. ######)
    const headingMatch = /^\s{0,3}(#{1,6})(?:\s+(.*))?$/.exec(line);
    if (headingMatch) {
      const depth = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = (headingMatch[2] ?? '').replace(/\s+#+\s*$/, '').trim();
      blocks.push({ type: 'heading', depth, text });
      i += 1;
      continue;
    }

    // 4. Horizontal rule (---, ***, ___)
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // 5. <details><summary>...</summary>...</details>
    if (/^\s*<details(?:\s|>|$)/i.test(line)) {
      const collected: string[] = [];
      i += 1;
      while (i < lines.length && !/<\/details>/i.test(lines[i])) {
        collected.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && /<\/details>/i.test(lines[i])) {
        i += 1;
      }
      const joined = collected.join('\n');
      const summaryMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(joined);
      const summary = summaryMatch ? summaryMatch[1].trim() : 'Details';
      const innerRaw = summaryMatch
        ? `${joined.slice(0, summaryMatch.index)}\n${joined.slice(summaryMatch.index + summaryMatch[0].length)}`
        : joined;
      blocks.push({
        type: 'details',
        summary,
        blocks: parseMarkdownBlocks(innerRaw),
      });
      continue;
    }

    // 6. Blockquote / GitHub Callout (> [!NOTE], > ...)
    if (/^\s{0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      const firstQuoteLine = quoteLines[0]?.trim() ?? '';
      const calloutMatch = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(firstQuoteLine);
      if (calloutMatch) {
        const kind = calloutMatch[1].toLowerCase() as CalloutKind;
        const remainderFirst = calloutMatch[2].trim();
        const innerLines = remainderFirst ? [remainderFirst, ...quoteLines.slice(1)] : quoteLines.slice(1);
        blocks.push({
          type: 'callout',
          kind,
          title: CALLOUT_LABELS[kind],
          blocks: parseMarkdownBlocks(innerLines.join('\n')),
        });
      } else {
        blocks.push({
          type: 'blockquote',
          blocks: parseMarkdownBlocks(quoteLines.join('\n')),
        });
      }
      continue;
    }

    // 7. GFM Table
    if (i + 1 < lines.length && line.includes('|')) {
      const alignments = parseTableSeparator(lines[i + 1]);
      if (alignments) {
        const headers = splitTableRow(line);
        const colCount = Math.max(headers.length, alignments.length);
        const normalizedHeaders = Array.from({ length: colCount }, (_, idx) => headers[idx] ?? '');
        const normalizedAligns = Array.from({ length: colCount }, (_, idx) => alignments[idx] ?? null);
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !isBlockStarter(lines, i)) {
          const rowCells = splitTableRow(lines[i]);
          rows.push(Array.from({ length: colCount }, (_, idx) => rowCells[idx] ?? ''));
          i += 1;
        }
        blocks.push({
          type: 'table',
          headers: normalizedHeaders,
          alignments: normalizedAligns,
          rows,
        });
        continue;
      }
    }

    // 8. List (ordered, unordered, task list, nested)
    const listStart = matchListLine(line);
    if (listStart) {
      const parsedList = parseList(lines, i, listStart.indent);
      blocks.push(parsedList.block);
      i = parsedList.nextIdx;
      continue;
    }

    // 9. Paragraph
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStarter(lines, i)) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push({
      type: 'paragraph',
      text: paraLines.join('\n'),
    });
  }

  return blocks;
}

function isLikelyInlineDollarMath(expr: string, afterCloseChar: string | undefined): boolean {
  if (!expr || expr.includes('\n')) return false;
  if (/^\s|\s$/.test(expr)) return false;
  // Guard currency values like "$100" or "$19.99 and $25.00"
  if (/^[\d.,]+(\s|$)/.test(expr) && /[a-zA-Z]/.test(expr) === false) {
    return false;
  }
  if (afterCloseChar && /\d/.test(afterCloseChar)) {
    return false;
  }
  return true;
}

function findInlineDelimiterEnd(text: string, fromIdx: number, delim: string): number {
  let pos = fromIdx;
  while (pos < text.length) {
    if (text[pos] === '\\') {
      pos += 2;
      continue;
    }
    if (text.startsWith(delim, pos)) {
      const prev = pos > 0 ? text[pos - 1] : '';
      if (!/\s/.test(prev)) {
        return pos;
      }
    }
    pos += 1;
  }
  return -1;
}

export function parseInlineTokens(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let textBuf = '';
  let i = 0;

  const flushText = () => {
    if (textBuf) {
      tokens.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };

  while (i < input.length) {
    const ch = input[i];

    // Escaped markdown characters
    if (ch === '\\' && i + 1 < input.length) {
      const next = input[i + 1];
      if (next === '(') {
        const end = input.indexOf('\\)', i + 2);
        if (end !== -1) {
          flushText();
          tokens.push({ type: 'math', expr: input.slice(i + 2, end).trim() });
          i = end + 2;
          continue;
        }
      }
      if ('\\`*_{}[]()#+-.!$|~'.includes(next)) {
        textBuf += next;
        i += 2;
        continue;
      }
    }

    // Explicit line break (<br> / <br/>)
    if (ch === '<') {
      const brMatch = /^<br\s*\/?>/i.exec(input.slice(i));
      if (brMatch) {
        flushText();
        tokens.push({ type: 'br' });
        i += brMatch[0].length;
        continue;
      }

      const kbdMatch = /^<kbd>([\s\S]*?)<\/kbd>/i.exec(input.slice(i));
      if (kbdMatch) {
        flushText();
        tokens.push({ type: 'kbd', text: kbdMatch[1] });
        i += kbdMatch[0].length;
        continue;
      }
    }

    // Newline within paragraph
    if (ch === '\n') {
      flushText();
      tokens.push({ type: 'br' });
      i += 1;
      continue;
    }

    // Inline code (`...` or ``...``)
    if (ch === '`') {
      let tickCount = 0;
      while (i + tickCount < input.length && input[i + tickCount] === '`') {
        tickCount += 1;
      }
      const closer = '`'.repeat(tickCount);
      const end = input.indexOf(closer, i + tickCount);
      if (end !== -1) {
        // Ensure exact tickCount match
        let code = input.slice(i + tickCount, end);
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim().length > 0) {
          code = code.slice(1, -1);
        }
        flushText();
        tokens.push({ type: 'code', code });
        i = end + tickCount;
        continue;
      }
    }

    // Inline math ($...$ or $$...$$ inline)
    if (ch === '$') {
      const isDouble = input[i + 1] === '$';
      const delim = isDouble ? '$$' : '$';
      const start = i + delim.length;
      let end = start;
      let found = -1;
      while (end < input.length) {
        if (input[end] === '\\') {
          end += 2;
          continue;
        }
        if (input.startsWith(delim, end)) {
          found = end;
          break;
        }
        end += 1;
      }
      if (found !== -1) {
        const expr = input.slice(start, found);
        const valid = isDouble
          ? expr.trim().length > 0
          : isLikelyInlineDollarMath(expr, input[found + 1]);
        if (valid) {
          flushText();
          tokens.push({ type: 'math', expr: expr.trim() });
          i = found + delim.length;
          continue;
        }
      }
    }

    // Images: ![alt](src)
    if (ch === '!' && input[i + 1] === '[') {
      const closeBracket = findBalancedBracketEnd(input, i + 1);
      if (closeBracket !== -1 && input[closeBracket + 1] === '(') {
        let depth = 1;
        let urlEnd = closeBracket + 2;
        while (urlEnd < input.length && depth > 0) {
          if (input[urlEnd] === '\\') {
            urlEnd += 2;
            continue;
          }
          if (input[urlEnd] === '(') depth += 1;
          else if (input[urlEnd] === ')') depth -= 1;
          if (depth === 0) break;
          urlEnd += 1;
        }
        if (depth === 0) {
          const rawAlt = input.slice(i + 2, closeBracket);
          const rawSrc = input.slice(closeBracket + 2, urlEnd).split(/\s+/)[0] ?? '';
          const safeImg = sanitizeImageSrc(rawSrc);
          flushText();
          if (safeImg) {
            tokens.push({
              type: 'image',
              alt: rawAlt,
              src: safeImg.src,
              isInlineSafe: safeImg.isInlineSafe,
            });
          } else {
            tokens.push({ type: 'text', text: rawAlt || '[image]' });
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Links: [label](url)
    if (ch === '[') {
      const closeBracket = findBalancedBracketEnd(input, i);
      if (closeBracket !== -1 && input[closeBracket + 1] === '(') {
        // Balance parentheses inside URL
        let depth = 1;
        let urlEnd = closeBracket + 2;
        while (urlEnd < input.length && depth > 0) {
          if (input[urlEnd] === '\\') {
            urlEnd += 2;
            continue;
          }
          if (input[urlEnd] === '(') depth += 1;
          else if (input[urlEnd] === ')') depth -= 1;
          if (depth === 0) break;
          urlEnd += 1;
        }
        if (depth === 0) {
          const rawLabel = input.slice(i + 1, closeBracket);
          const rawHref = input.slice(closeBracket + 2, urlEnd).split(/\s+/)[0] ?? '';
          const safeHref = sanitizeHref(rawHref);
          flushText();
          if (safeHref) {
            tokens.push({
              type: 'link',
              label: parseInlineTokens(rawLabel),
              href: safeHref,
            });
          } else {
            tokens.push({ type: 'text', text: rawLabel });
          }
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Strikethrough: ~~...~~
    if (input.startsWith('~~', i) && i + 2 < input.length && !/\s/.test(input[i + 2])) {
      const end = findInlineDelimiterEnd(input, i + 2, '~~');
      if (end !== -1) {
        flushText();
        tokens.push({ type: 'strike', children: parseInlineTokens(input.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Bold + Italic: ***...*** or ___...___
    if (
      (input.startsWith('***', i) || input.startsWith('___', i)) &&
      i + 3 < input.length &&
      !/\s/.test(input[i + 3])
    ) {
      const delim = input.slice(i, i + 3);
      const end = findInlineDelimiterEnd(input, i + 3, delim);
      if (end !== -1) {
        flushText();
        tokens.push({ type: 'bold_italic', children: parseInlineTokens(input.slice(i + 3, end)) });
        i = end + 3;
        continue;
      }
    }

    // Bold: **...** or __...__
    if (
      (input.startsWith('**', i) || input.startsWith('__', i)) &&
      i + 2 < input.length &&
      !/\s/.test(input[i + 2])
    ) {
      const delim = input.slice(i, i + 2);
      const end = findInlineDelimiterEnd(input, i + 2, delim);
      if (end !== -1) {
        flushText();
        tokens.push({ type: 'bold', children: parseInlineTokens(input.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    // Italic: *...* or _..._ (avoid splitting snake_case words for `_`)
    if ((ch === '*' || ch === '_') && i + 1 < input.length && !/\s/.test(input[i + 1])) {
      const prevChar = i > 0 ? input[i - 1] : '';
      const validOpen = ch === '*' || !/[a-zA-Z0-9]/.test(prevChar);
      if (validOpen) {
        const end = findInlineDelimiterEnd(input, i + 1, ch);
        const afterClose = end !== -1 ? input[end + 1] ?? '' : '';
        const validClose = end !== -1 && (ch === '*' || !/[a-zA-Z0-9]/.test(afterClose));
        if (validClose) {
          flushText();
          tokens.push({ type: 'italic', children: parseInlineTokens(input.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }

    textBuf += ch;
    i += 1;
  }

  flushText();
  return tokens;
}
