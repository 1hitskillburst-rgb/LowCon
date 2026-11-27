import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildSandboxedHtmlSrcDoc,
  buildSvgDataUri,
  detectArtifactPreviewKind,
  detectTableDelimiter,
  MAX_PREVIEW_TABLE_ROWS,
  parseDelimitedTable,
  SANDBOX_HTML_CSP,
  sanitizeSvgForPreview,
  supportsRichPreview,
} from '../src/core/artifactPreview';
import { FilePreviewPanel } from '../src/components/chat/FilePreviewPanel';
import { RichArtifactPreview } from '../src/components/chat/RichArtifactPreview';
import { ChatView } from '../src/components/chat/ChatView';
import { createDefaultModels } from '../src/core/storage';
import type { GeneratedFileArtifact, Session } from '../src/core/types';

test('detectArtifactPreviewKind and supportsRichPreview classify extensions and fallback languages', () => {
  assert.equal(detectArtifactPreviewKind('README.md'), 'markdown');
  assert.equal(detectArtifactPreviewKind('docs/GUIDE.MARKDOWN'), 'markdown');
  assert.equal(detectArtifactPreviewKind('sales.csv'), 'csv');
  assert.equal(detectArtifactPreviewKind('metrics.TSV'), 'csv');
  assert.equal(detectArtifactPreviewKind('diagram.svg', 'xml'), 'svg');
  assert.equal(detectArtifactPreviewKind('widget.html'), 'html');
  assert.equal(detectArtifactPreviewKind('legacy.HTM'), 'html');

  assert.equal(detectArtifactPreviewKind('main.rs', 'rust'), 'code');
  assert.equal(detectArtifactPreviewKind('config.xml', 'xml'), 'code');
  assert.equal(detectArtifactPreviewKind('notes.txt', 'text'), 'code');
  assert.equal(detectArtifactPreviewKind('data.json', 'json'), 'code');

  assert.equal(detectArtifactPreviewKind('untitled', 'markdown'), 'markdown');
  assert.equal(detectArtifactPreviewKind('untitled', 'tsv'), 'csv');
  assert.equal(detectArtifactPreviewKind('untitled', 'svg'), 'svg');
  assert.equal(detectArtifactPreviewKind('untitled', 'html'), 'html');
  assert.equal(detectArtifactPreviewKind('untitled', 'python'), 'code');

  assert.equal(supportsRichPreview('README.md'), true);
  assert.equal(supportsRichPreview('data.csv'), true);
  assert.equal(supportsRichPreview('icon.svg'), true);
  assert.equal(supportsRichPreview('app.html'), true);
  assert.equal(supportsRichPreview('app.tsx'), false);

  assert.equal(detectTableDelimiter('data.csv'), ',');
  assert.equal(detectTableDelimiter('data.tsv'), '\t');
  assert.equal(detectTableDelimiter('untitled', 'tsv'), '\t');
});

test('parseDelimitedTable parses RFC-4180 CSV/TSV with quotes, escaped quotes, CRLF, and multiline cells', () => {
  const csv = [
    '\uFEFFid,name,notes,empty',
    '1,"Alice, Bob","Line 1\n""Quoted"" Line 2",""',
    '2,Charlie,"Has ""quotes"" inside",plain',
    '',
  ].join('\r\n');

  const parsed = parseDelimitedTable(csv);
  assert.deepEqual(parsed.headers, ['id', 'name', 'notes', 'empty']);
  assert.deepEqual(parsed.rows, [
    ['1', 'Alice, Bob', 'Line 1\n"Quoted" Line 2', ''],
    ['2', 'Charlie', 'Has "quotes" inside', 'plain'],
  ]);
  assert.equal(parsed.truncated, false);

  const tsv = 'key\tval\n"a\tb"\t"c""d"\n';
  const parsedTsv = parseDelimitedTable(tsv, '\t');
  assert.deepEqual(parsedTsv.headers, ['key', 'val']);
  assert.deepEqual(parsedTsv.rows, [['a\tb', 'c"d']]);
  assert.equal(parsedTsv.truncated, false);

  assert.deepEqual(parseDelimitedTable('   \n  '), {
    headers: [],
    rows: [],
    truncated: false,
  });
});

test('parseDelimitedTable caps rendered rows at MAX_PREVIEW_TABLE_ROWS and reports truncation accurately', () => {
  const exactRows = Array.from({ length: MAX_PREVIEW_TABLE_ROWS }, (_, i) => `${i + 1},row_${i + 1}`);
  const exactCsv = ['id,label', ...exactRows, ''].join('\n');
  const exactResult = parseDelimitedTable(exactCsv);
  assert.equal(exactResult.rows.length, MAX_PREVIEW_TABLE_ROWS);
  assert.equal(exactResult.truncated, false);

  const overRows = Array.from({ length: MAX_PREVIEW_TABLE_ROWS + 25 }, (_, i) => `${i + 1},row_${i + 1}`);
  const overCsv = ['id,label', ...overRows].join('\n');
  const overResult = parseDelimitedTable(overCsv);
  assert.equal(overResult.headers[0], 'id');
  assert.equal(overResult.rows.length, MAX_PREVIEW_TABLE_ROWS);
  assert.equal(overResult.rows[0]?.[1], 'row_1');
  assert.equal(overResult.rows[MAX_PREVIEW_TABLE_ROWS - 1]?.[1], `row_${MAX_PREVIEW_TABLE_ROWS}`);
  assert.equal(overResult.truncated, true);
});

test('sanitizeSvgForPreview strips scripts, event handlers, javascript: URLs, XXE, and unsafe CSS', () => {
  const maliciousSvg = [
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!ENTITY xxe "bad">]>',
    '<?xml-stylesheet type="text/xsl" href="evil.xsl"?>',
    '<svg/onload=alert(1) viewBox="0 0 120 80">',
    '<script>alert("xss1")</script>',
    '<script src="https://evil.test/x.js" />',
    '<scr<script></script>ipt>alert("xss2")</scr</script>ipt>',
    '<scr<script></script>ipt>alert("xss3")</script>',
    '<style>@import url("https://evil.test/x.css"); .c { fill: #2A3FE0; background: expression(alert(1)); }</style>',
    '<a xlink:href="  &#106;avascript:alert(3)"><rect width="20" height="20" onclick="alert(4)" class="c"/></a>',
    '<a href="java&#x09;script:alert(5)"><text x="10" y="30">onclick=safe label</text></a>',
    '<animate attributeName="href" to="javascript:alert(6)" onbegin="alert(7)" />',
    '<circle cx="60" cy="40" r="18" fill="url(#grad)" />',
    '</svg>',
  ].join('\n');

  const clean = sanitizeSvgForPreview(maliciousSvg);
  assert.ok(clean.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(clean.includes('<circle cx="60" cy="40" r="18" fill="url(#grad)" />'));
  assert.ok(clean.includes('<text x="10" y="30">onclick=safe label</text>'));

  const lower = clean.toLowerCase();
  assert.equal(lower.includes('<script'), false);
  assert.equal(lower.includes('<!doctype'), false);
  assert.equal(lower.includes('<!entity'), false);
  assert.equal(lower.includes('xml-stylesheet'), false);
  assert.equal(lower.includes('onload='), false);
  assert.equal(lower.includes('onclick="alert'), false);
  assert.equal(lower.includes('onbegin='), false);
  assert.equal(lower.includes('javascript:'), false);
  assert.equal(lower.includes('expression('), false);
  assert.equal(lower.includes('@import'), false);
  assert.equal(lower.includes('<animate'), false);

  const dataUri = buildSvgDataUri(maliciousSvg);
  assert.ok(dataUri.startsWith('data:image/svg+xml;charset=utf-8,'));
  assert.equal(decodeURIComponent(dataUri).toLowerCase().includes('<script'), false);
  assert.equal(sanitizeSvgForPreview('<div>not svg</div>'), '');

  // Privacy: external remote URLs inside SVG image hrefs or style url(...) must be stripped
  const trackingSvg = [
    '<svg viewBox="0 0 100 100">',
    '<style>.bg { background: url("https://tracker.test/bg.png"); } .ok { fill: url(#grad); }</style>',
    '<image href="https://tracker.test/pixel.png" width="10" height="10" />',
    '<image xlink:href="//tracker.test/proto.png" width="10" height="10" />',
    '<rect width="100" height="100" class="ok" />',
    '</svg>',
  ].join('\n');
  const cleanTracking = sanitizeSvgForPreview(trackingSvg);
  assert.equal(cleanTracking.includes('tracker.test'), false);
  assert.ok(cleanTracking.includes('fill: url(#grad)'));
});

test('buildSandboxedHtmlSrcDoc injects strict CSP meta tag into documents and fragments', () => {
  const fullDoc = '<!DOCTYPE html><html><HEAD><title>Widget</title></HEAD><body><div id="app"></div></body></html>';
  const withHead = buildSandboxedHtmlSrcDoc(fullDoc);
  assert.ok(withHead.includes(`<meta http-equiv="Content-Security-Policy" content="${SANDBOX_HTML_CSP}">`));
  assert.ok(withHead.indexOf('Content-Security-Policy') < withHead.indexOf('<title>Widget</title>'));

  const noHeadDoc = '<html><body><p>Hello</p></body></html>';
  const injectedHead = buildSandboxedHtmlSrcDoc(noHeadDoc);
  assert.ok(injectedHead.includes('<head>'));
  assert.ok(injectedHead.includes(SANDBOX_HTML_CSP));
  assert.ok(injectedHead.indexOf(SANDBOX_HTML_CSP) < injectedHead.indexOf('<body>'));

  const fragment = '<div class="card">Chart</div><script>const tag = "<head>";</script>';
  const wrappedFragment = buildSandboxedHtmlSrcDoc(fragment);
  assert.ok(wrappedFragment.startsWith('<!DOCTYPE html>'));
  assert.ok(wrappedFragment.includes(SANDBOX_HTML_CSP));
  assert.ok(wrappedFragment.includes('<body>'));
  assert.ok(wrappedFragment.includes(fragment));

  const permissiveDoc =
    '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><title>X</title></head><body></body></html>';
  const replaced = buildSandboxedHtmlSrcDoc(permissiveDoc);
  assert.equal(replaced.includes("default-src *"), false);
  assert.ok(replaced.includes(SANDBOX_HTML_CSP));

  const precedingImg = '<img src="https://evil.test/px"><head><title>Late</title></head><body>ok</body>';
  const guardedImg = buildSandboxedHtmlSrcDoc(precedingImg);
  assert.ok(guardedImg.indexOf(SANDBOX_HTML_CSP) < guardedImg.indexOf('<img src="https://evil.test/px">'));

  const precedingScript =
    '<script src="https://evil.test/x.js"></script><html><head><title>Late</title></head><body>ok</body></html>';
  const guardedScript = buildSandboxedHtmlSrcDoc(precedingScript);
  assert.ok(
    guardedScript.indexOf(SANDBOX_HTML_CSP) <
      guardedScript.indexOf('<script src="https://evil.test/x.js">'),
  );

  const imgInsideHtmlBeforeHead =
    '<!DOCTYPE html><html><img src="https://evil.test/px"><head><title>Late</title></head><body>ok</body></html>';
  const guardedInsideHtml = buildSandboxedHtmlSrcDoc(imgInsideHtmlBeforeHead);
  assert.ok(
    guardedInsideHtml.indexOf(SANDBOX_HTML_CSP) <
      guardedInsideHtml.indexOf('<img src="https://evil.test/px">'),
  );

  // Privacy: meta http-equiv="refresh" redirect tags must be stripped
  const refreshDoc =
    '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=https://evil.test/steal"><title>Hi</title></head><body>ok</body></html>';
  const strippedRefresh = buildSandboxedHtmlSrcDoc(refreshDoc);
  assert.equal(strippedRefresh.toLowerCase().includes('http-equiv="refresh"'), false);
  assert.equal(strippedRefresh.includes('evil.test/steal'), false);
  assert.ok(strippedRefresh.includes(SANDBOX_HTML_CSP));
});

test('RichArtifactPreview renders markdown, csv, sanitized svg, and sandboxed html iframe safely', () => {
  const baseFile: Omit<GeneratedFileArtifact, 'filename' | 'title' | 'language' | 'content'> = {
    id: 'art_1',
    createdAt: 1700000000000,
  };

  const mdHtml = renderToStaticMarkup(
    React.createElement(RichArtifactPreview, {
      kind: 'markdown',
      file: {
        ...baseFile,
        filename: 'report.md',
        title: 'Report',
        language: 'markdown',
        content: '# Summary\n\nAll **systems** nominal.',
      },
    }),
  );
  assert.ok(mdHtml.includes('data-testid="rich-markdown-preview"'));
  assert.ok(mdHtml.includes('<h1'));
  assert.ok(mdHtml.includes('<strong'));

  const overRows = Array.from({ length: MAX_PREVIEW_TABLE_ROWS + 2 }, (_, i) => `${i + 1},val_${i + 1}`);
  const csvHtml = renderToStaticMarkup(
    React.createElement(RichArtifactPreview, {
      kind: 'csv',
      file: {
        ...baseFile,
        filename: 'metrics.csv',
        title: 'Metrics',
        language: 'csv',
        content: ['id,value', ...overRows].join('\n'),
      },
    }),
  );
  assert.ok(csvHtml.includes('data-testid="rich-csv-preview"'));
  assert.ok(csvHtml.includes('data-testid="rich-csv-truncated-notice"'));
  assert.ok(csvHtml.includes('<table'));
  assert.ok(csvHtml.includes('500 rows'));

  const svgHtml = renderToStaticMarkup(
    React.createElement(RichArtifactPreview, {
      kind: 'svg',
      file: {
        ...baseFile,
        filename: 'chart.svg',
        title: 'Sales Chart',
        language: 'svg',
        content: '<svg onload="alert(1)" viewBox="0 0 10 10"><script>alert(2)</script><circle cx="5" cy="5" r="4"/></svg>',
      },
    }),
  );
  assert.ok(svgHtml.includes('data-testid="rich-svg-preview"'));
  assert.ok(svgHtml.includes('data-testid="rich-svg-image"'));
  assert.ok(svgHtml.includes('src="data:image/svg+xml;charset=utf-8,'));
  assert.equal(svgHtml.toLowerCase().includes('%3cscript'), false);
  assert.equal(svgHtml.toLowerCase().includes('onload'), false);

  const htmlView = renderToStaticMarkup(
    React.createElement(RichArtifactPreview, {
      kind: 'html',
      file: {
        ...baseFile,
        filename: 'widget.html',
        title: 'Interactive Widget',
        language: 'html',
        content: '<div>Widget</div><script>console.log(1)</script>',
      },
    }),
  );
  assert.ok(htmlView.includes('data-testid="rich-html-iframe"'));
  assert.ok(htmlView.includes('sandbox="allow-scripts"'));
  assert.ok(htmlView.includes('title="Interactive Widget"'));
  assert.ok(htmlView.includes('Content-Security-Policy'));
});

test('FilePreviewPanel defaults rich formats to Preview mode with 1-click Code toggle and renders code-only files directly', () => {
  const mdFile: GeneratedFileArtifact = {
    id: 'fp_md',
    filename: 'notes.md',
    title: 'Notes',
    language: 'markdown',
    content: '# Release Notes\n\n- Ready',
    createdAt: 1700000000000,
    isEdited: true,
  };
  const mdPanel = renderToStaticMarkup(
    React.createElement(FilePreviewPanel, { file: mdFile, onClose: () => {} }),
  );
  assert.ok(mdPanel.includes('data-testid="file-preview-mode-toggle"'));
  assert.ok(mdPanel.includes('data-testid="file-preview-mode-preview"'));
  assert.ok(mdPanel.includes('data-testid="file-preview-mode-code"'));
  assert.ok(mdPanel.includes('data-testid="rich-markdown-preview"'));
  assert.ok(mdPanel.includes('data-testid="file-preview-edited-badge"'));
  assert.equal(mdPanel.includes('data-testid="file-preview-code-view"'), false);

  const csvPanel = renderToStaticMarkup(
    React.createElement(FilePreviewPanel, {
      file: {
        id: 'fp_csv',
        filename: 'metrics.csv',
        title: 'Metrics',
        language: 'csv',
        content: 'k,v\na,1',
        createdAt: 1700000000000,
      },
      onClose: () => {},
    }),
  );
  assert.ok(csvPanel.includes('data-testid="rich-csv-preview"'));

  const codePanel = renderToStaticMarkup(
    React.createElement(FilePreviewPanel, {
      file: {
        id: 'fp_rs',
        filename: 'main.rs',
        title: 'Main',
        language: 'rust',
        content: 'fn main() {}',
        createdAt: 1700000000000,
      },
      onClose: () => {},
    }),
  );
  assert.equal(codePanel.includes('data-testid="file-preview-mode-toggle"'), false);
  assert.ok(codePanel.includes('data-testid="file-preview-code-view"'));
});

test('ChatView renders rich artifact card badges, edit badges, tool activity pills, and indexed attachment badge', () => {
  const models = createDefaultModels();
  const session: Session = {
    id: 'sess_preview',
    title: 'Rich UI Session',
    subtitle: 'Local test',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    messages: [
      {
        id: 'm_ast',
        role: 'assistant',
        authorName: 'LowCon',
        createdAt: 1700000001000,
        content: 'Updated artifacts.',
        sources: [],
        toolActivity: [
          'Calculated: 37.7',
          'Updated report.md (2 lines)',
          'Saved note: Release policy',
        ],
        generatedFiles: [
          {
            id: 'g_md',
            filename: 'report.md',
            title: 'Report',
            language: 'markdown',
            content: '# Report',
            createdAt: 1700000001000,
            isEdited: true,
          },
          {
            id: 'g_csv',
            filename: 'data.csv',
            title: 'Metrics',
            language: 'csv',
            content: 'a,b\n1,2',
            createdAt: 1700000001000,
          },
          {
            id: 'g_html',
            filename: 'widget.html',
            title: 'Widget',
            language: 'html',
            content: '<div>ok</div>',
            createdAt: 1700000001000,
          },
        ],
      },
    ],
  };

  const largeContent = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  const html = renderToStaticMarkup(
    React.createElement(ChatView, {
      session,
      models,
      activeModelId: models[0].id,
      onSelectActiveModel: () => {},
      connectedLmModels: [],
      selectedLmModel: '',
      onSelectLmModel: () => {},
      effortLevel: 'medium',
      onChangeEffortLevel: () => {},
      backendLabel: 'Offline Mock',
      workerStatus: { state: 'loaded', modelId: models[0].id, modelName: models[0].name, backend: 'mock', contextLimit: 8192 },
      composerText: '',
      onComposerTextChange: () => {},
      attachedFile: { name: 'big.log', content: largeContent },
      onAttachFile: () => {},
      memoryRetrievalEnabled: true,
      onToggleMemoryRetrieval: () => {},
      isGenerating: false,
      hoveredSegment: null,
      onHoverSegment: () => {},
      onSendMessage: () => {},
      onStopGeneration: () => {},
      onNewSession: () => {},
      onSummarizeSession: () => true,
      onReviewSummaries: () => {},
      onOpenSources: () => {},
      onSaveAsNote: () => {},
      onOpenFilePreview: () => {},
    }),
  );

  assert.ok(html.includes('data-testid="file-artifact-rich-badge-g_md"'));
  assert.ok(html.includes('data-testid="file-artifact-edited-badge-g_md"'));
  assert.ok(html.includes('Markdown · MD · 1 line'));
  assert.ok(html.includes('Table · CSV · 2 lines'));
  assert.ok(html.includes('HTML · HTML · 1 line'));
  assert.ok(html.includes('Sandbox'));
  assert.ok(html.includes('Calculated: 37.7'));
  assert.ok(html.includes('Updated report.md (2 lines)'));
  assert.ok(html.includes('Saved note: Release policy'));
  assert.ok(html.includes('data-testid="attached-file-indexed-badge"'));
});
