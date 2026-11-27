import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  parseInlineTokens,
  parseMarkdownBlocks,
  sanitizeHref,
  sanitizeImageSrc,
} from '../src/core/markdown.ts';
import { MarkdownMessage } from '../src/components/chat/MarkdownMessage.tsx';

test('parses closed and streaming unclosed fenced code blocks', () => {
  const md = [
    '# Rust Example',
    '',
    '```rust',
    'fn main() {',
    '    println!("hello");',
    '}',
    '```',
    '',
    '~~~python',
    'print("streaming")',
  ].join('\n');

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0], { type: 'heading', depth: 1, text: 'Rust Example' });
  assert.deepEqual(blocks[1], {
    type: 'code',
    lang: 'rust',
    code: 'fn main() {\n    println!("hello");\n}',
    closed: true,
  });
  assert.deepEqual(blocks[2], {
    type: 'code',
    lang: 'python',
    code: 'print("streaming")',
    closed: false,
  });
});

test('parses display math ($$ and \\[) and inline math ($ and \\() while preserving currency', () => {
  const blocks = parseMarkdownBlocks([
    '$$',
    'E = mc^2',
    '$$',
    '',
    '\\[ a^2 + b^2 = c^2 \\]',
    '',
    'Inline $x^2 + y^2$ and \\(\\alpha + \\beta\\) cost $100 and $25.50.',
  ].join('\n'));

  assert.equal(blocks[0].type, 'math');
  if (blocks[0].type === 'math') {
    assert.equal(blocks[0].expr, 'E = mc^2');
    assert.equal(blocks[0].closed, true);
  }

  assert.equal(blocks[1].type, 'math');
  if (blocks[1].type === 'math') {
    assert.equal(blocks[1].expr, 'a^2 + b^2 = c^2');
    assert.equal(blocks[1].closed, true);
  }

  assert.equal(blocks[2].type, 'paragraph');
  if (blocks[2].type === 'paragraph') {
    const tokens = parseInlineTokens(blocks[2].text);
    const mathTokens = tokens.filter((t) => t.type === 'math');
    assert.equal(mathTokens.length, 2);
    assert.deepEqual(mathTokens[0], { type: 'math', expr: 'x^2 + y^2' });
    assert.deepEqual(mathTokens[1], { type: 'math', expr: '\\alpha + \\beta' });

    const joinedText = tokens
      .filter((t): t is { type: 'text'; text: string } => t.type === 'text')
      .map((t) => t.text)
      .join('');
    assert.ok(joinedText.includes('$100'));
    assert.ok(joinedText.includes('$25.50'));
  }
});

test('parses GFM tables, GitHub callouts, task lists, nested lists, and details', () => {
  const md = [
    '> [!WARNING]',
    '> Watch the context budget.',
    '',
    '| Feature | Status | Score |',
    '| :--- | :---: | ---: |',
    '| Code | Ready | 100 |',
    '| Math | Ready | 99 |',
    '',
    '- [x] Task one',
    '  1. Nested step',
    '- [ ] Task two',
    '',
    '<details>',
    '<summary>More info</summary>',
    'Inside **details** with <kbd>Ctrl</kbd>',
    '</details>',
  ].join('\n');

  const blocks = parseMarkdownBlocks(md);
  assert.equal(blocks[0].type, 'callout');
  if (blocks[0].type === 'callout') {
    assert.equal(blocks[0].kind, 'warning');
    assert.equal(blocks[0].title, 'Warning');
  }

  assert.equal(blocks[1].type, 'table');
  if (blocks[1].type === 'table') {
    assert.deepEqual(blocks[1].headers, ['Feature', 'Status', 'Score']);
    assert.deepEqual(blocks[1].alignments, ['left', 'center', 'right']);
    assert.equal(blocks[1].rows.length, 2);
  }

  assert.equal(blocks[2].type, 'list');
  if (blocks[2].type === 'list') {
    assert.equal(blocks[2].items[0].checked, true);
    assert.equal(blocks[2].items[0].children?.[0].ordered, true);
    assert.equal(blocks[2].items[1].checked, false);
  }

  assert.equal(blocks[3].type, 'details');
  if (blocks[3].type === 'details') {
    assert.equal(blocks[3].summary, 'More info');
    assert.equal(blocks[3].blocks[0].type, 'paragraph');
  }
});

test('sanitizes unsafe link protocols, blocks protocol-relative URLs, and handles nested brackets & privacy-safe images', () => {
  assert.equal(sanitizeHref('https://example.com/docs'), 'https://example.com/docs');
  assert.equal(sanitizeHref('/local/path'), '/local/path');
  assert.equal(sanitizeHref('//evil.test/leak'), null);
  assert.equal(sanitizeHref('javascript:alert(1)'), null);
  assert.equal(sanitizeHref('data:text/html,hi'), null);

  assert.deepEqual(sanitizeImageSrc('data:image/png;base64,AAA'), {
    src: 'data:image/png;base64,AAA',
    isInlineSafe: true,
  });
  assert.deepEqual(sanitizeImageSrc('https://tracker.test/pixel.png'), {
    src: 'https://tracker.test/pixel.png',
    isInlineSafe: false,
  });
  assert.equal(sanitizeImageSrc('javascript:alert(1)'), null);
  assert.equal(sanitizeImageSrc('//evil.test/px.png'), null);

  const tokens = parseInlineTokens(
    '**bold** *italic* ~~old~~ `code` [safe](https://ok.test) [bad](javascript:alert(1)) [docs [v2]](https://example.com/v2) ![tracker](https://tracker.test/px.png) ![logo](data:image/png;base64,AAA)',
  );
  assert.ok(tokens.some((t) => t.type === 'bold'));
  assert.ok(tokens.some((t) => t.type === 'italic'));
  assert.ok(tokens.some((t) => t.type === 'strike'));
  assert.ok(tokens.some((t) => t.type === 'code' && t.code === 'code'));
  assert.ok(tokens.some((t) => t.type === 'link' && t.href === 'https://ok.test/'));
  assert.ok(
    tokens.some(
      (t) =>
        t.type === 'link' &&
        t.href === 'https://example.com/v2' &&
        t.label.map((child) => (child.type === 'text' ? child.text : '')).join('') === 'docs [v2]',
    ),
  );
  assert.ok(!tokens.some((t) => t.type === 'link' && t.href.includes('javascript:')));
  assert.ok(
    tokens.some(
      (t) =>
        t.type === 'image' &&
        t.alt === 'tracker' &&
        t.src === 'https://tracker.test/px.png' &&
        t.isInlineSafe === false,
    ),
  );
  assert.ok(
    tokens.some(
      (t) =>
        t.type === 'image' &&
        t.alt === 'logo' &&
        t.src === 'data:image/png;base64,AAA' &&
        t.isInlineSafe === true,
    ),
  );

  // MarkdownMessage must never emit an <img src="https://..."> auto-fetch for remote markdown images
  const rendered = renderToStaticMarkup(
    React.createElement(MarkdownMessage, {
      content: '![Secret Pixel](https://tracker.test/px.png)\n\n![Inline Logo](data:image/png;base64,AAA)',
    }),
  );
  assert.ok(rendered.includes('data-testid="blocked-remote-image"'));
  assert.equal(rendered.includes('<img src="https://tracker.test/px.png"'), false);
  assert.ok(rendered.includes('src="data:image/png;base64,AAA"'));
});
