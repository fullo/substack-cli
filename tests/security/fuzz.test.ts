import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToDoc } from '../../src/markdown/prosemirror.ts';
import { parseArticle } from '../../src/markdown/frontmatter.ts';
import { UsageError } from '../../src/util/errors.ts';

// PRNG deterministico (mulberry32): il corpus è identico a ogni esecuzione.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  '# ', '## ', '##### ', '- ', '1. ', '> ', '```', '`', '**', '*', '_', '~~', '[a](', ')', '![i](', 'https://x.io', 'javascript:',
  'mailto:a@b.c', '<b>', '</b>', '<script>', '|', '---', '\n', '\n\n', '  ', '\t', '&amp;', '&', '<', '\\', 'ciao', 'è', '日本',
  '\u202e', '\u0000', '[', ']', '(', '- [ ] ', '    ', '[r]: ', 'title: x', ': ', '&#0;', '!!', '@',
];

function* corpus(n: number, seed: number) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(r() * 40);
    let s = '';
    for (let j = 0; j < len; j++) s += PIECES[Math.floor(r() * PIECES.length)];
    yield s;
  }
}

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) return node.forEach((c) => walk(c, visit));
  if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((c) => walk(c, visit));
  }
}

// Ogni singola conversione deve terminare in fretta: budget largo per non essere instabile in CI.
const PER_CALL_BUDGET_MS = 2_000;

function timed<T>(fn: () => T, label: string): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const dt = performance.now() - t0;
    assert.ok(dt < PER_CALL_BUDGET_MS, `troppo lento (${dt.toFixed(0)} ms): ${label}`);
  }
}

test('fuzz Markdown: o UsageError, o documento sicuro; mai crash né schemi vietati', () => {
  let ok = 0;
  let rejected = 0;
  for (const input of corpus(3000, 12345)) {
    try {
      const doc = timed(() => markdownToDoc(input), JSON.stringify(input));
      ok++;
      assert.equal(doc.type, 'doc');
      assert.ok(doc.content.length > 0);
      walk(doc, (n) => {
        const attrs = n.attrs as { href?: unknown; src?: unknown } | undefined;
        if (attrs?.href !== undefined) assert.match(String(attrs.href), /^(https?:|mailto:)/i, `href vietato da: ${JSON.stringify(input)}`);
        if (attrs?.src !== undefined) assert.match(String(attrs.src), /^https:/i, `src vietato da: ${JSON.stringify(input)}`);
        if (n.type === 'text') {
          assert.ok(typeof n.text === 'string' && n.text.length > 0);
          assert.ok(!/[\u0000\u202e]/.test(n.text), `carattere vietato nel testo da: ${JSON.stringify(input)}`);
        }
      });
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      rejected++;
      assert.ok(e instanceof UsageError, `eccezione non tipizzata da ${JSON.stringify(input)}: ${e}`);
    }
  }
  assert.ok(ok > 100, `il corpus deve produrre anche input validi (validi: ${ok})`);
  assert.ok(rejected > 100, `il corpus deve produrre anche input rifiutati (rifiutati: ${rejected})`);
});

test('fuzz front-matter: mai eccezioni non tipizzate', () => {
  for (const input of corpus(1500, 67890)) {
    for (const wrapped of [`---\ntitle: T\n---\n\n${input}`, `---\n${input}\n---\n\nx`, `---\ntitle: ${input}\n---\n\nx`, input]) {
      try {
        const a = timed(() => parseArticle(wrapped), JSON.stringify(wrapped));
        assert.equal(typeof a.frontMatter.title, 'string');
        assert.ok(!/[\t\r\n\u0000\u202e]/.test(a.frontMatter.title), `titolo non sicuro da ${JSON.stringify(wrapped)}`);
      } catch (e) {
        if (e instanceof assert.AssertionError) throw e;
        assert.ok(e instanceof UsageError, `${JSON.stringify(wrapped)} → ${e}`);
      }
    }
  }
});

test('input patologici terminano in tempo ragionevole con un risultato o un UsageError', () => {
  const inputs = [
    '*'.repeat(50_000), '['.repeat(20_000), '> '.repeat(5_000) + 'x', '`'.repeat(30_000), '_a'.repeat(30_000),
    '![a]('.repeat(5_000), '*a '.repeat(30_000), '~~a '.repeat(20_000), '!'.repeat(100_000), '- '.repeat(10_000) + 'x',
    '[a]('.repeat(10_000), '<'.repeat(100_000), '&'.repeat(100_000), 'a\n'.repeat(100_000), '|a'.repeat(50_000),
  ];
  const t0 = performance.now();
  for (const s of inputs) {
    try { timed(() => markdownToDoc(s), `${JSON.stringify(s.slice(0, 8))}… (${s.length})`); } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      assert.ok(e instanceof UsageError, `${JSON.stringify(s.slice(0, 8))} → ${e}`);
    }
  }
  const total = performance.now() - t0;
  assert.ok(total < 15_000, `troppo lento: ${total.toFixed(0)} ms`);
});
