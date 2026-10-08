import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticle } from '../../../src/markdown/frontmatter.ts';
import { UsageError } from '../../../src/util/errors.ts';

test('front-matter YAML oltre 8 KB rifiutato prima del parsing (50k chiavi in meno di 200 ms)', () => {
  const keys = Array.from({ length: 50_000 }, (_, i) => `k${i}: ${i}`).join('\n');
  const src = `---\ntitle: T\n${keys}\n---\n\nCorpo.`;
  const t0 = performance.now();
  assert.throws(() => parseArticle(src), (e: unknown) => e instanceof UsageError && /8 KB/.test(e.message) && e.message.length < 300);
  assert.ok(performance.now() - t0 < 200, `${performance.now() - t0} ms`);
});

test('front-matter: il limite è sui byte del blocco YAML (8192 ammessi, 8193 no)', () => {
  const pad = (n: number) => `title: ${'a'.repeat(n - 'title: '.length)}`;
  // Il titolo è comunque troppo lungo (max 300): conta solo che l'errore NON sia quello di dimensione.
  assert.throws(() => parseArticle(`---\n${pad(8192)}\n---\n`), (e: unknown) => e instanceof UsageError && !/8 KB/.test(e.message));
  assert.throws(() => parseArticle(`---\n${pad(8193)}\n---\n`), (e: unknown) => e instanceof UsageError && /8 KB/.test(e.message));
  // Caratteri multibyte: "title: " + 4093 x "è" (2 byte) = 8193 byte con soli 4100 caratteri.
  assert.throws(() => parseArticle(`---\ntitle: ${'è'.repeat(4093)}\n---\n`), (e: unknown) => e instanceof UsageError && /8 KB/.test(e.message));
});

test('front-matter: elenco delle chiavi sconosciute troncato (prime 5 + conteggio)', () => {
  const keys = Array.from({ length: 40 }, (_, i) => `chiave${i}: 1`).join('\n');
  assert.throws(() => parseArticle(`---\ntitle: T\n${keys}\n---\n`), (e: unknown) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, /chiave0, chiave1, chiave2, chiave3, chiave4 \(e altre 35\)/);
    assert.ok(!e.message.includes('chiave5'));
    return true;
  });
  assert.throws(() => parseArticle('---\ntitle: T\ntags: x\n---\n'),
    (e: unknown) => e instanceof UsageError && e.message.includes('chiavi non ammesse: tags') && !e.message.includes('altre'));
});
