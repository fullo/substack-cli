import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticle } from '../../../src/markdown/frontmatter.ts';
import { UsageError } from '../../../src/util/errors.ts';

const OK = '---\ntitle: Il mio titolo\nsubtitle: "Con: due punti"\n---\n\nCorpo **qui**.\n';

test('legge title e subtitle e converte il corpo', () => {
  const a = parseArticle(OK);
  assert.equal(a.frontMatter.title, 'Il mio titolo');
  assert.equal(a.frontMatter.subtitle, 'Con: due punti');
  assert.equal(a.doc.content[0]!.type, 'paragraph');
});

test('accetta CRLF e subtitle assente', () => {
  const a = parseArticle('---\r\ntitle: T\r\n---\r\n\r\nCiao\r\n');
  assert.equal(a.frontMatter.subtitle, undefined);
  assert.equal(a.doc.content.length, 1);
});

test('front-matter mancante, non chiuso o senza title: errore', () => {
  assert.throws(() => parseArticle('Solo corpo'), UsageError);
  assert.throws(() => parseArticle('---\ntitle: T\nCorpo senza chiusura'), UsageError);
  assert.throws(() => parseArticle('---\nsubtitle: x\n---\n\nCorpo'), UsageError);
  assert.throws(() => parseArticle('---\ntitle: ""\n---\n\nCorpo'), UsageError);
});

test('chiavi sconosciute e YAML pericoloso/rotto sono rifiutati', () => {
  assert.throws(() => parseArticle('---\ntitle: T\ntags: [a]\n---\n\nCorpo'), /tags/);
  assert.throws(() => parseArticle('---\ntitle: [rotto\n---\n\nCorpo'), UsageError);
  assert.throws(() => parseArticle('---\na: &x [1]\ntitle: *x\n---\n\nCorpo'), UsageError);
  assert.throws(() => parseArticle('---\ntitle: T\ntitle: U\n---\n\nCorpo'), UsageError);
});

test('title non stringa o troppo lungo: errore', () => {
  assert.throws(() => parseArticle('---\ntitle: 123\n---\n\nCorpo'), UsageError);
  assert.throws(() => parseArticle(`---\ntitle: ${'a'.repeat(301)}\n---\n\nCorpo`), UsageError);
});

test('un "---" nel corpo non chiude di nuovo il front-matter', () => {
  const a = parseArticle('---\ntitle: T\n---\n\nPrima\n\n---\n\nDopo\n');
  assert.deepEqual(a.doc.content.map((n) => n.type), ['paragraph', 'horizontal_rule', 'paragraph']);
});

test('corpo vuoto: errore', () => {
  assert.throws(() => parseArticle('---\ntitle: T\n---\n\n'), UsageError);
});

test('title e subtitle: caratteri di controllo, bidi, invisibili e a capo sono rifiutati', () => {
  const bads = ['a‮b', 'a\u0007b', 'a‏b', 'a﻿b', 'a b'];
  for (const bad of bads) {
    assert.throws(() => parseArticle(`---\ntitle: "${bad}"\n---\n\nCorpo`), UsageError, `title ${JSON.stringify(bad)}`);
    assert.throws(() => parseArticle(`---\ntitle: T\nsubtitle: "${bad}"\n---\n\nCorpo`), UsageError, `subtitle ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseArticle('---\ntitle: "riga uno\nriga due"\n---\n\nCorpo'), /title/);
  assert.throws(() => parseArticle('---\ntitle: T\nsubtitle: "a\rb"\n---\n\nCorpo'), /subtitle/);
  assert.throws(() => parseArticle('---\ntitle: |\n  blocco\n  su due righe\n---\n\nCorpo'), /title/);
});

test('un BOM UTF-8 iniziale viene ignorato', () => {
  const a = parseArticle('﻿' + OK);
  assert.equal(a.frontMatter.title, 'Il mio titolo');
  assert.equal(parseArticle('﻿---\r\ntitle: T\r\n---\r\n\r\nCiao\r\n').frontMatter.title, 'T');
});
