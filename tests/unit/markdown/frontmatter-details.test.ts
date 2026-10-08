// Test aggiuntivi dall'analisi dei mutanti (Stryker): messaggi esatti, confini di lunghezza e della
// riga di chiusura del front-matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticle } from '../../../src/markdown/frontmatter.ts';
import { UsageError } from '../../../src/util/errors.ts';

const usage = (src: string, message: string | RegExp) =>
  assert.throws(() => parseArticle(src), (e: unknown) =>
    e instanceof UsageError && (typeof message === 'string' ? e.message === message : message.test(e.message)), src.slice(0, 50));

const MISSING = 'Front-matter mancante: il file deve iniziare con "---" e contenere almeno "title"';
const UNCLOSED = 'Front-matter non chiuso: manca la riga "---" di chiusura';
const SINGLE = 'deve stare su una riga, senza caratteri di controllo, di direzione o invisibili';

test('front-matter mancante o non chiuso: messaggi esatti', () => {
  usage('Corpo', MISSING);
  usage('---title: T\n---\n\nCorpo', MISSING);
  usage(' ---\ntitle: T\n---\n\nCorpo', MISSING);
  usage('---\ntitle: T\n', UNCLOSED);
  usage('---\ntitle: T\n---x\n\nCorpo', UNCLOSED);
  usage('---\ntitle: T\n----\nCorpo', UNCLOSED);
});

test('la chiusura "---" a fine file è valida (corpo vuoto → errore del corpo, non del front-matter)', () => {
  usage('---\ntitle: T\n---', 'Contenuto vuoto');
});

test('la chiusura viene cercata dopo l\'apertura; front-matter vuoto → title mancante', () => {
  usage('---\n---\n\nCorpo', UNCLOSED);
  usage('---\n\n---\n\nCorpo', 'Front-matter non valido: title: Required');
});

test('il corpo inizia dopo la riga di chiusura: una sola riga vuota iniziale viene tolta', () => {
  const a = parseArticle('---\ntitle: T\n---\nCorpo');
  assert.deepEqual(a.doc.content, [{ type: 'paragraph', content: [{ type: 'text', text: 'Corpo' }] }]);
  const b = parseArticle('---\ntitle: T\n---\n    codice');
  assert.equal(b.doc.content[0]!.type, 'code_block');
  assert.equal(b.doc.content[0]!.content![0]!.text, 'codice');
});

test('YAML: messaggio con il dettaglio del parser; radice non oggetto', () => {
  usage('---\ntitle: [rotto\n---\n\nCorpo', /^Front-matter YAML non valido: /);
  usage('---\n- a\n---\n\nCorpo', /^Front-matter non valido: \(radice\): /);
});

test('YAML: alias vietati anche tra chiavi ammesse e con valori stringa', () => {
  usage('---\ntitle: &x T\nsubtitle: *x\n---\n\nCorpo', /^Front-matter YAML non valido: /);
});

test('YAML core: le date restano stringhe, i numeri no', () => {
  assert.equal(parseArticle('---\ntitle: 2026-10-08\n---\n\nCorpo').frontMatter.title, '2026-10-08');
  usage('---\ntitle: 12\n---\n\nCorpo', 'Front-matter non valido: title: Expected string, received number');
});

test('confini di lunghezza: title 1..300, subtitle 0..500', () => {
  assert.equal(parseArticle(`---\ntitle: ${'a'.repeat(300)}\n---\n\nCorpo`).frontMatter.title.length, 300);
  usage(`---\ntitle: ${'a'.repeat(301)}\n---\n\nCorpo`, /^Front-matter non valido: title: /);
  assert.equal(parseArticle(`---\ntitle: T\nsubtitle: ${'b'.repeat(500)}\n---\n\nCorpo`).frontMatter.subtitle!.length, 500);
  usage(`---\ntitle: T\nsubtitle: ${'b'.repeat(501)}\n---\n\nCorpo`, /^Front-matter non valido: subtitle: /);
  assert.equal(parseArticle('---\ntitle: T\nsubtitle: ""\n---\n\nCorpo').frontMatter.subtitle, '');
});

test('messaggi di validazione: riga singola e più problemi separati da "; "', () => {
  usage('---\ntitle: "a\\tb"\n---\n\nCorpo', `Front-matter non valido: title: ${SINGLE}`);
  usage('---\ntitle: "a\\tb"\nsubtitle: "c\\td"\n---\n\nCorpo', `Front-matter non valido: title: ${SINGLE}; subtitle: ${SINGLE}`);
  usage('---\ntitle: T\nfoo: 1\n---\n\nCorpo', /^Front-matter non valido: \(radice\): Unrecognized key\(s\) in object: 'foo'$/);
});

test('BOM solo iniziale; CRLF convertiti in tutto il file', () => {
  usage('x﻿---\ntitle: T\n---\n\nCorpo', MISSING);
  const a = parseArticle('﻿---\r\ntitle: T\r\nsubtitle: S\r\n---\r\n\r\nUno\r\nDue\r\n');
  assert.equal(a.frontMatter.subtitle, 'S');
  assert.equal(a.doc.content[0]!.content![0]!.text, 'Uno\nDue');
});
