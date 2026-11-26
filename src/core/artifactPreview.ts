export type ArtifactPreviewKind = 'code' | 'markdown' | 'csv' | 'svg' | 'html';

export interface DelimitedTableResult {
  headers: string[];
  rows: string[][];
  truncated: boolean;
}

export const MAX_PREVIEW_TABLE_ROWS = 500;

export const SANDBOX_HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:;";

const CSP_META_TAG = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_HTML_CSP}">`;

const EXTENSION_TO_KIND: Record<string, ArtifactPreviewKind> = {
  md: 'markdown',
  markdown: 'markdown',
  csv: 'csv',
  tsv: 'csv',
  svg: 'svg',
  html: 'html',
  htm: 'html',
};

const LANGUAGE_TO_KIND: Record<string, ArtifactPreviewKind> = {
  md: 'markdown',
  markdown: 'markdown',
  gfm: 'markdown',
  csv: 'csv',
  tsv: 'csv',
  svg: 'svg',
  html: 'html',
  htm: 'html',
};

export function detectArtifactPreviewKind(
  filename: string,
  language?: string,
): ArtifactPreviewKind {
  const base = filename.trim().split(/[\\/]/).pop() ?? '';
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx !== -1 && dotIdx < base.length - 1) {
    const ext = base.slice(dotIdx + 1).toLowerCase();
    return EXTENSION_TO_KIND[ext] ?? 'code';
  }

  const normalizedLang = (language ?? '').trim().toLowerCase();
  if (normalizedLang) {
    return LANGUAGE_TO_KIND[normalizedLang] ?? 'code';
  }

  return 'code';
}

export function supportsRichPreview(filename: string, language?: string): boolean {
  return detectArtifactPreviewKind(filename, language) !== 'code';
}

export function detectTableDelimiter(filename: string, language?: string): ',' | '\t' {
  const base = filename.trim().split(/[\\/]/).pop() ?? '';
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx !== -1 && dotIdx < base.length - 1) {
    const ext = base.slice(dotIdx + 1).toLowerCase();
    if (ext === 'tsv') return '\t';
    if (ext === 'csv') return ',';
  }
  if ((language ?? '').trim().toLowerCase() === 'tsv') {
    return '\t';
  }
  return ',';
}

/**
 * RFC-4180-compatible CSV/TSV parser supporting quoted fields, escaped quotes (""),
 * embedded newlines inside quotes, CRLF/LF line endings, and row-count capping.
 */
export function parseDelimitedTable(
  text: string,
  delimiter: ',' | '\t' = ',',
  maxRows: number = MAX_PREVIEW_TABLE_ROWS,
): DelimitedTableResult {
  const normalized = text.startsWith('\uFEFF') ? text.slice(1) : text;
  if (!normalized.trim()) {
    return { headers: [], rows: [], truncated: false };
  }

  const rowLimit = Math.max(0, maxRows);
  let headers: string[] | null = null;
  const rows: string[][] = [];
  let truncated = false;

  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let fieldHadQuote = false;
  let rowHadQuote = false;

  const commitField = () => {
    currentRow.push(currentField);
    if (fieldHadQuote) {
      rowHadQuote = true;
    }
    currentField = '';
    fieldHadQuote = false;
  };

  const commitRow = (): boolean => {
    commitField();
    const isBlankRow = currentRow.length === 1 && currentRow[0] === '' && !rowHadQuote;
    const finishedRow = currentRow;
    currentRow = [];
    rowHadQuote = false;

    if (isBlankRow) {
      return true;
    }

    if (headers === null) {
      headers = finishedRow;
      return true;
    }

    if (rows.length >= rowLimit) {
      truncated = true;
      return false;
    }

    rows.push(finishedRow);
    return true;
  };

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < normalized.length && normalized[i + 1] === '"') {
          currentField += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
      continue;
    }

    if (ch === '"' && currentField === '' && !fieldHadQuote) {
      inQuotes = true;
      fieldHadQuote = true;
      continue;
    }

    if (ch === delimiter) {
      commitField();
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && i + 1 < normalized.length && normalized[i + 1] === '\n') {
        i += 1;
      }
      if (!commitRow()) {
        return { headers: headers ?? [], rows, truncated };
      }
      continue;
    }

    currentField += ch;
  }

  // Flush final record if the input did not end immediately after a newline,
  // or if there is accumulated field/row content.
  if (
    inQuotes ||
    fieldHadQuote ||
    currentField.length > 0 ||
    currentRow.length > 0
  ) {
    commitRow();
  }

  return {
    headers: headers ?? [],
    rows,
    truncated,
  };
}

const BLOCKED_SVG_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'applet',
  'frame',
  'frameset',
  'handler',
  'meta',
  'base',
  'link',
]);

const URL_ATTRIBUTES = new Set([
  'href',
  'xlink:href',
  'src',
  'action',
  'formaction',
  'poster',
  'data',
  'codebase',
  'cite',
  'background',
]);

const ANIMATION_TAGS = new Set(['animate', 'set', 'animatetransform', 'animatemotion']);
const ANIMATION_VALUE_ATTRS = new Set(['values', 'from', 'to', 'by']);

const NAMED_ENTITIES: Record<string, string> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
};

function decodeHtmlEntitiesForCheck(input: string): string {
  return input.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));?/g, (full, dec, hex, named) => {
    if (dec) {
      const code = Number.parseInt(dec, 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return '';
    }
    if (hex) {
      const code = Number.parseInt(hex, 16);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
      return '';
    }
    if (named) {
      return NAMED_ENTITIES[named.toLowerCase()] ?? full;
    }
    return full;
  });
}

function isUnsafeUrlValue(rawValue: string): boolean {
  const decoded = decodeHtmlEntitiesForCheck(rawValue);
  // Strip ASCII whitespace and control characters that browsers ignore before scheme names
  // eslint-disable-next-line no-control-regex
  const compact = decoded.replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();

  if (compact.startsWith('javascript:') || compact.startsWith('vbscript:')) {
    return true;
  }

  if (compact.startsWith('data:')) {
    return !/^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon)(?:;|,)/.test(
      compact,
    );
  }

  return false;
}

function containsUnsafeScheme(rawValue: string): boolean {
  const parts = rawValue.split(';');
  return parts.some((part) => isUnsafeUrlValue(part));
}

function sanitizeCssText(rawCss: string): string {
  const withoutComments = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  let cleaned = withoutComments
    .replace(/@import\b[^;]*(?:;|$)/gi, '')
    .replace(/expression\s*\(/gi, 'invalid-expr(')
    .replace(/-moz-binding\s*:/gi, 'invalid-binding:')
    .replace(/behavior\s*:/gi, 'invalid-behavior:');

  cleaned = cleaned.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (match, _quote, urlTarget) => {
    if (isUnsafeUrlValue(urlTarget)) {
      return 'url(about:blank)';
    }
    return match;
  });

  if (/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(decodeHtmlEntitiesForCheck(cleaned))) {
    cleaned = cleaned.replace(/javascript\s*:/gi, 'blocked:');
  }
  if (/v\s*b\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(decodeHtmlEntitiesForCheck(cleaned))) {
    cleaned = cleaned.replace(/vbscript\s*:/gi, 'blocked:');
  }

  return cleaned;
}

function stripBlockedSvgElements(rawSvg: string): string {
  let result = rawSvg
    .replace(/<!DOCTYPE\s+[^>[]*(?:\[[\s\S]*?\])?\s*>/gi, '')
    .replace(/<!(?:ENTITY|ELEMENT|ATTLIST|NOTATION)\b[^>]*>/gi, '')
    .replace(/<\?[\s\S]*?\?>/g, '');

  const blockedNames = Array.from(BLOCKED_SVG_TAGS).join('|');
  const pairedTagRe = new RegExp(
    `<(${blockedNames})(?:\\s[^>]*|\\/[^>]*)?>[\\s\\S]*?<\\/\\1\\s*>`,
    'gi',
  );
  const selfClosingTagRe = new RegExp(
    `<(${blockedNames})(?:\\s[^>]*|\\/[^>]*)?\\/>`,
    'gi',
  );
  const unclosedTagRe = new RegExp(
    `<(${blockedNames})(?:\\s[^>]*|\\/[^>]*)?>[\\s\\S]*$`,
    'gi',
  );

  // Repeat paired/self-closing removal to fixed point so nested tags cannot reconstruct a blocked element
  let prev = '';
  while (prev !== result) {
    prev = result;
    result = result.replace(pairedTagRe, '').replace(selfClosingTagRe, '');
  }

  return result.replace(unclosedTagRe, '');
}

function escapeAttrValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface ParsedTagAttribute {
  name: string;
  hasValue: boolean;
  value: string;
}

function parseTagAttributes(rawAttrs: string): ParsedTagAttribute[] {
  const attrs: ParsedTagAttribute[] = [];
  let i = 0;
  const len = rawAttrs.length;

  while (i < len) {
    while (i < len && (/\s/.test(rawAttrs[i]) || rawAttrs[i] === '/')) {
      i += 1;
    }
    if (i >= len) break;

    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(rawAttrs[i])) {
      i += 1;
    }
    const name = rawAttrs.slice(nameStart, i);
    if (!name) {
      i += 1;
      continue;
    }

    while (i < len && /\s/.test(rawAttrs[i])) {
      i += 1;
    }

    if (i < len && rawAttrs[i] === '=') {
      i += 1;
      while (i < len && /\s/.test(rawAttrs[i])) {
        i += 1;
      }
      let value = '';
      if (i < len && (rawAttrs[i] === '"' || rawAttrs[i] === "'")) {
        const quote = rawAttrs[i];
        i += 1;
        const valStart = i;
        while (i < len && rawAttrs[i] !== quote) {
          i += 1;
        }
        value = rawAttrs.slice(valStart, i);
        if (i < len && rawAttrs[i] === quote) {
          i += 1;
        }
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(rawAttrs[i])) {
          i += 1;
        }
        value = rawAttrs.slice(valStart, i);
      }
      attrs.push({ name, hasValue: true, value });
    } else {
      attrs.push({ name, hasValue: false, value: '' });
    }
  }

  return attrs;
}

function findTagEnd(input: string, startAfterName: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = startAfterName; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Sanitizes an SVG document for safe preview rendering:
 * - Strips DOCTYPE/entity declarations, processing instructions, <script> and active/embedded tags
 * - Strips all on* event handler attributes and javascript:/vbscript:/unsafe data: URLs
 * - Sanitizes inline style attributes and <style> blocks
 * - Ensures xmlns="http://www.w3.org/2000/svg" is present on the root <svg> element
 */
export function sanitizeSvgForPreview(svgContent: string): string {
  const stripped = stripBlockedSvgElements(svgContent).trim();
  if (!stripped) return '';

  const out: string[] = [];
  let inStyleBlock = false;
  let styleBuffer = '';
  let i = 0;

  while (i < stripped.length) {
    const ltIdx = stripped.indexOf('<', i);
    if (ltIdx === -1) {
      const tail = stripped.slice(i);
      if (inStyleBlock) {
        styleBuffer += tail;
      } else {
        out.push(tail);
      }
      break;
    }

    const chunk = stripped.slice(i, ltIdx);
    if (chunk) {
      if (inStyleBlock) {
        styleBuffer += chunk;
      } else {
        out.push(chunk);
      }
    }

    if (stripped.startsWith('<!--', ltIdx)) {
      const closeComment = stripped.indexOf('-->', ltIdx + 4);
      i = closeComment === -1 ? stripped.length : closeComment + 3;
      continue;
    }

    if (stripped.startsWith('<![CDATA[', ltIdx)) {
      const closeCdata = stripped.indexOf(']]>', ltIdx + 9);
      if (closeCdata === -1) {
        i = stripped.length;
      } else {
        const cdataText = stripped.slice(ltIdx + 9, closeCdata);
        if (inStyleBlock) {
          styleBuffer += cdataText;
        } else {
          out.push(`<![CDATA[${cdataText}]]>`);
        }
        i = closeCdata + 3;
      }
      continue;
    }

    // Closing tag
    if (stripped[ltIdx + 1] === '/') {
      const closeMatch = /^<\/([A-Za-z_][A-Za-z0-9:._-]*)\s*>/.exec(stripped.slice(ltIdx));
      if (closeMatch) {
        const tagName = closeMatch[1];
        const tagLower = tagName.toLowerCase();
        if (inStyleBlock && tagLower === 'style') {
          out.push(sanitizeCssText(styleBuffer));
          out.push('</style>');
          styleBuffer = '';
          inStyleBlock = false;
        } else if (!inStyleBlock && !BLOCKED_SVG_TAGS.has(tagLower)) {
          out.push(`</${tagName}>`);
        }
        i = ltIdx + closeMatch[0].length;
        continue;
      }
      if (inStyleBlock) {
        styleBuffer += '<';
      } else {
        out.push('&lt;');
      }
      i = ltIdx + 1;
      continue;
    }

    // Opening or self-closing tag
    const openNameMatch = /^<([A-Za-z_][A-Za-z0-9:._-]*)(?=[\s/>])/.exec(stripped.slice(ltIdx));
    if (!openNameMatch) {
      if (inStyleBlock) {
        styleBuffer += '<';
      } else {
        out.push('&lt;');
      }
      i = ltIdx + 1;
      continue;
    }

    const tagName = openNameMatch[1];
    const tagLower = tagName.toLowerCase();
    const tagEnd = findTagEnd(stripped, ltIdx + 1 + tagName.length);
    if (tagEnd === -1) {
      i = stripped.length;
      break;
    }

    if (inStyleBlock) {
      styleBuffer += stripped.slice(ltIdx, tagEnd + 1);
      i = tagEnd + 1;
      continue;
    }

    if (BLOCKED_SVG_TAGS.has(tagLower)) {
      i = tagEnd + 1;
      continue;
    }

    const rawBody = stripped.slice(ltIdx + 1 + tagName.length, tagEnd);
    const selfClosing = /\/\s*$/.test(rawBody);
    const rawAttrs = selfClosing ? rawBody.replace(/\/\s*$/, '') : rawBody;
    const parsedAttrs = parseTagAttributes(rawAttrs);

    // Block animation elements targeting href or event handlers
    if (ANIMATION_TAGS.has(tagLower)) {
      const targetAttr = parsedAttrs.find((a) => a.name.toLowerCase() === 'attributename');
      const targetLower = targetAttr?.value.trim().toLowerCase() ?? '';
      if (
        targetLower === 'href' ||
        targetLower.endsWith(':href') ||
        targetLower.startsWith('on')
      ) {
        i = tagEnd + 1;
        continue;
      }
    }

    let hasXmlns = false;
    const safeAttrs: string[] = [];

    for (const attr of parsedAttrs) {
      const lowerName = attr.name.toLowerCase();
      const localName = lowerName.includes(':') ? (lowerName.split(':').pop() ?? lowerName) : lowerName;

      // Strip all on* event handlers (onload, onclick, onbegin, onerror, etc.)
      if (localName.startsWith('on')) {
        continue;
      }

      if (lowerName === 'xmlns') {
        hasXmlns = true;
      }

      if (
        URL_ATTRIBUTES.has(lowerName) ||
        lowerName.endsWith(':href') ||
        (ANIMATION_TAGS.has(tagLower) && ANIMATION_VALUE_ATTRS.has(lowerName))
      ) {
        if (containsUnsafeScheme(attr.value)) {
          continue;
        }
      }

      if (lowerName === 'style') {
        const cleanStyle = sanitizeCssText(attr.value);
        safeAttrs.push(`style="${escapeAttrValue(cleanStyle)}"`);
        continue;
      }

      if (attr.hasValue) {
        safeAttrs.push(`${attr.name}="${escapeAttrValue(attr.value)}"`);
      } else {
        safeAttrs.push(attr.name);
      }
    }

    if (tagLower === 'svg' && !hasXmlns) {
      safeAttrs.unshift('xmlns="http://www.w3.org/2000/svg"');
    }

    const attrPart = safeAttrs.length > 0 ? ` ${safeAttrs.join(' ')}` : '';
    out.push(`<${tagName}${attrPart}${selfClosing ? ' /' : ''}>`);

    if (tagLower === 'style' && !selfClosing) {
      inStyleBlock = true;
      styleBuffer = '';
    }

    i = tagEnd + 1;
  }

  if (inStyleBlock && styleBuffer) {
    out.push(sanitizeCssText(styleBuffer));
    out.push('</style>');
  }

  const sanitized = out.join('').trim();
  if (!/<svg\b/i.test(sanitized)) {
    return '';
  }
  return sanitized;
}

export function buildSvgDataUri(svgContent: string): string {
  const sanitized = sanitizeSvgForPreview(svgContent);
  if (!sanitized) return '';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitized)}`;
}

function findTopLevelTagMatch(html: string, tagName: string): { start: number; end: number } | null {
  const target = tagName.toLowerCase();
  const len = html.length;
  let i = 0;

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return null;

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }

    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = findTagEnd(html, lt + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const match = /^<([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])/.exec(html.slice(lt));
    if (!match) {
      i = lt + 1;
      continue;
    }

    const foundName = match[1].toLowerCase();
    const tagEnd = findTagEnd(html, lt + 1 + foundName.length);
    if (tagEnd === -1) return null;

    if (foundName === target) {
      return { start: lt, end: tagEnd + 1 };
    }

    if (foundName === 'script' || foundName === 'style') {
      const closeRe = new RegExp(`<\\/${foundName}\\s*>`, 'i');
      const rest = html.slice(tagEnd + 1);
      const closeMatch = closeRe.exec(rest);
      i = closeMatch ? tagEnd + 1 + closeMatch.index + closeMatch[0].length : len;
      continue;
    }

    i = tagEnd + 1;
  }

  return null;
}

function stripExistingCspMetaTags(html: string): string {
  return html.replace(
    /<meta\b[^>]*\bhttp-equiv\s*=\s*(?:"Content-Security-Policy"|'Content-Security-Policy'|Content-Security-Policy)[^>]*>/gi,
    '',
  );
}

/**
 * Wraps or injects a strict Content-Security-Policy <meta> tag into an HTML document
 * or fragment so a sandboxed iframe (`sandbox="allow-scripts"`) can execute inline
 * widget scripts/styles with zero network access and zero access to host storage.
 */
export function buildSandboxedHtmlSrcDoc(htmlContent: string): string {
  const cleaned = stripExistingCspMetaTags(htmlContent).trim();

  const headMatch = findTopLevelTagMatch(cleaned, 'head');
  if (headMatch) {
    return `${cleaned.slice(0, headMatch.end)}\n${CSP_META_TAG}${cleaned.slice(headMatch.end)}`;
  }

  const htmlMatch = findTopLevelTagMatch(cleaned, 'html');
  if (htmlMatch) {
    return `${cleaned.slice(0, htmlMatch.end)}\n<head>\n<meta charset="utf-8">\n${CSP_META_TAG}\n</head>${cleaned.slice(htmlMatch.end)}`;
  }

  const bodyMatch = findTopLevelTagMatch(cleaned, 'body');
  if (bodyMatch) {
    return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n${CSP_META_TAG}\n</head>\n${cleaned}\n</html>`;
  }

  return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n${CSP_META_TAG}\n</head>\n<body>\n${cleaned}\n</body>\n</html>`;
}
