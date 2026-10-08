// Test aggiuntivi dall'analisi dei mutanti (Stryker): documenti ProseMirror esatti (nomi dei nodi,
// attributi, marchi), messaggi d'errore e confini dei limiti.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer, Tokenizer } from 'marked';
import { markdownToDoc, unescapeHtml } from '../../../src/markdown/prosemirror.ts';
import { UsageError } from '../../../src/util/errors.ts';

const doc = (md: string) => markdownToDoc(md).content;
const text = (t: string, marks?: unknown[]) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const usage = (md: string, message: string | RegExp) =>
  assert.throws(() => markdownToDoc(md), (e: unknown) =>
    e instanceof UsageError && (typeof message === 'string' ? e.message === message : message.test(e.message)), md.slice(0, 40));

test('documento: radice "doc"', () => {
  assert.deepEqual(markdownToDoc('ciao'), { type: 'doc', content: [para(text('ciao'))] });
});

test('a capo forzato, escape, a capo morbido', () => {
  assert.deepEqual(doc('a  \nb'), [para(text('a'), { type: 'hard_break' }, text('b'))]);
  assert.deepEqual(doc('a\\*b'), [para(text('a'), text('*'), text('b'))]);
  assert.deepEqual(doc('riga1\nriga2'), [para(text('riga1\nriga2'))]);
});

test('marchi: ordine di annidamento e copie indipendenti', () => {
  assert.deepEqual(doc('[**b**](https://e.x)'), [para(text('b', [{ type: 'link', attrs: { href: 'https://e.x/' } }, { type: 'strong' }]))]);
  assert.deepEqual(doc('**[l](https://e.x) e *c***'), [para(
    text('l', [{ type: 'strong' }, { type: 'link', attrs: { href: 'https://e.x/' } }]),
    text(' e ', [{ type: 'strong' }]),
    text('c', [{ type: 'strong' }, { type: 'em' }]),
  )]);
  const d = doc('**a** **b**');
  const [a, , b] = d[0]!.content!;
  assert.notEqual(a!.marks![0], b!.marks![0]);
  assert.deepEqual(doc('`x` **`y`**'), [para(text('x', [{ type: 'code' }]), text(' '), text('y', [{ type: 'strong' }, { type: 'code' }]))]);
});

test('autolink e mailto diventano link normalizzati', () => {
  assert.deepEqual(doc('https://e.x'), [para(text('https://e.x', [{ type: 'link', attrs: { href: 'https://e.x/' } }]))]);
  assert.deepEqual(doc('a@b.it'), [para(text('a@b.it', [{ type: 'link', attrs: { href: 'mailto:a@b.it' } }]))]);
  assert.deepEqual(doc('[x](http://e.x/p?q=1)'), [para(text('x', [{ type: 'link', attrs: { href: 'http://e.x/p?q=1' } }]))]);
});

test('titoli: livello come attributo, titolo vuoto scartato, messaggio per h5/h6', () => {
  assert.deepEqual(doc('### Tre'), [{ type: 'heading', attrs: { level: 3 }, content: [text('Tre')] }]);
  assert.deepEqual(doc('#\n\ntesto'), [para(text('testo'))]);
  usage('##### Cinque', 'Titoli supportati solo fino al livello 4 (trovato h5)');
  usage('###### Sei', 'Titoli supportati solo fino al livello 4 (trovato h6)');
});

test('liste e citazioni: struttura esatta', () => {
  assert.deepEqual(doc('- a\n- b'), [{ type: 'bullet_list', content: [
    { type: 'list_item', content: [para(text('a'))] }, { type: 'list_item', content: [para(text('b'))] }] }]);
  assert.deepEqual(doc('1. a'), [{ type: 'ordered_list', content: [{ type: 'list_item', content: [para(text('a'))] }] }]);
  assert.deepEqual(doc('> a\n>\n> b'), [{ type: 'blockquote', content: [para(text('a')), para(text('b'))] }]);
  usage('- [x] fatto', 'Le task list non sono supportate');
});

test('blocchi di codice: lingua o null, contenuto vuoto', () => {
  assert.deepEqual(doc('```\nx\n```'), [{ type: 'code_block', attrs: { language: null }, content: [text('x')] }]);
  assert.deepEqual(doc('```\n```'), [{ type: 'code_block', attrs: { language: null }, content: [] }]);
  assert.deepEqual(doc('```py\na < b\n```'), [{ type: 'code_block', attrs: { language: 'py' }, content: [text('a < b')] }]);
  assert.deepEqual(doc('***'), [{ type: 'horizontal_rule' }]);
});

test('immagini: struttura captionedImage/image2, alt null se vuoto, entità ripristinate', () => {
  assert.deepEqual(doc('![](https://e.x/i.png)'), [{ type: 'captionedImage', content: [{ type: 'image2', attrs: { src: 'https://e.x/i.png', alt: null } }] }]);
  assert.deepEqual(doc('![a &amp; b](https://e.x/i.png)  '), [{ type: 'captionedImage', content: [{ type: 'image2', attrs: { src: 'https://e.x/i.png', alt: 'a & b' } }] }]);
  usage('![a](http://e.x/i.png)', 'Immagine con schema non consentito (http:): http://e.x/i.png');
  usage('![a](/rel.png)', 'Immagine non valido (serve un URL assoluto): /rel.png');
  usage('testo ![a](https://e.x/i.png)', 'Immagine inline non supportata: mettila in un paragrafo a sé');
});

test('link: messaggi esatti per schema vietato e URL relativo', () => {
  usage('[x](ftp://a.b)', 'Link con schema non consentito (ftp:): ftp://a.b');
  usage('[x](/rel)', 'Link non valido (serve un URL assoluto): /rel');
});

test('costrutti non supportati: messaggi con il tipo di token', () => {
  usage('~~x~~', 'Markdown non supportato (inline): del');
  usage('a<br>b', 'Markdown non supportato (inline): html');
  usage('<div>x</div>', 'Markdown non supportato: html');
  usage('[r]\n\n[r]: https://e.x', 'Markdown non supportato: def');
  usage('| a | b |\n|---|---|\n| 1 | 2 |', 'Markdown non supportato: table');
});

test('contenuto vuoto, caratteri vietati, dimensione: messaggi esatti e confine dei 300 KB', () => {
  usage('', 'Contenuto vuoto');
  usage('[](https://e.x)', 'Contenuto vuoto');
  usage('a\u0001b', 'Il testo contiene caratteri di controllo o di direzione non ammessi');
  const limit = 300_000;
  assert.equal(markdownToDoc('a'.repeat(limit)).content.length, 1);
  usage('a'.repeat(limit + 1), 'Contenuto troppo grande (max 300 KB)');
  // il limite è in byte UTF-8, non in caratteri
  assert.equal(markdownToDoc('è'.repeat(limit / 2)).content.length, 1);
  usage('è'.repeat(limit / 2) + 'a', 'Contenuto troppo grande (max 300 KB)');
});

test('annidamento: 20 livelli ammessi, oltre "Markdown troppo annidato"', () => {
  const quotes = (n: number) => '> '.repeat(n) + 'x';
  let deepest = 0;
  for (let n = 1; n <= 30; n++) {
    try { markdownToDoc(quotes(n)); deepest = n; } catch (e) {
      assert.ok(e instanceof UsageError && e.message === 'Markdown troppo annidato', String(n));
      break;
    }
  }
  // blocks(depth 0) + 1 livello per citazione; il paragrafo interno aggiunge un livello a inline
  assert.equal(deepest, 19);
  const lists = (n: number) => Array.from({ length: n }, (_, i) => `${'  '.repeat(i)}- x`).join('\n');
  assert.equal(markdownToDoc(lists(9)).content[0]!.type, 'bullet_list');
  usage(lists(40), 'Markdown troppo annidato');
});

test('unescapeHtml: solo le entità note', () => {
  assert.equal(unescapeHtml('&amp;&lt;&gt;&quot;&#39;'), `&<>"'`);
  assert.equal(unescapeHtml('&copy; &#40; &AMP;'), '&copy; &#40; &AMP;');
  assert.equal(unescapeHtml('x'), 'x');
});

test('input patologici: messaggio esatto del budget di lavoro', () => {
  usage('*a '.repeat(90_000), /^Markdown troppo (complesso da elaborare \(troppi delimitatori \*, _, ~ o ! non chiusi\): semplifica il testo|annidato)$/);
  usage('!'.repeat(250_000), 'Markdown troppo complesso da elaborare (troppi delimitatori *, _, ~ o ! non chiusi): semplifica il testo');
});

test('annidamento: ogni livello (citazione, lista, enfasi, link, titolo) conta; confini esatti', () => {
  const q = (n: number, inner: string) => '> '.repeat(n) + inner;
  // un separatore non ha contenuto inline: lo ferma il controllo sui blocchi
  assert.equal(markdownToDoc(q(20, '---')).content[0]!.type, 'blockquote');
  usage(q(21, '---'), 'Markdown troppo annidato');
  // testo semplice fino a 19 citazioni; enfasi, grassetto e link aggiungono un livello
  for (const inner of ['**x**', '*x*', '[x](https://e.x)']) {
    assert.equal(markdownToDoc(q(18, inner)).content.length, 1, inner);
    usage(q(19, inner), 'Markdown troppo annidato');
  }
  assert.equal(markdownToDoc(q(19, '# x')).content.length, 1);
  usage(q(20, '# x'), 'Markdown troppo annidato');
  const lists = (n: number) => Array.from({ length: n }, (_, i) => `${'  '.repeat(i)}- x`).join('\n');
  assert.equal(markdownToDoc(lists(19)).content[0]!.type, 'bullet_list');
  usage(lists(20), 'Markdown troppo annidato');
});

test('immagine seguita da testo nello stesso paragrafo: è un\'immagine inline (rifiutata), non un captionedImage', () => {
  usage('![a](https://e.x/i.png) testo', 'Immagine inline non supportata: mettila in un paragrafo a sé');
});

test('errori non-Error lanciati da marked diventano UsageError con il testo dell\'errore', () => {
  const original = Tokenizer.prototype.paragraph;
  try {
    for (const [thrown, text] of [['boom', 'boom'], [null, 'null'], [undefined, 'undefined']] as const) {
      Tokenizer.prototype.paragraph = function () { throw thrown; };
      usage('ciao', `Markdown non elaborabile: ${text}`);
    }
  } finally {
    Tokenizer.prototype.paragraph = original;
  }
});

// Rami difensivi di inline(): marked 18 oggi non produce token "text" con figli né testi vuoti, ma
// conversione e limiti devono restare corretti se li producesse (si simulano dentro il tokenizer).
test('rami difensivi: token text con figli, figli vuoti, profondità dei figli, testo vuoto', () => {
  const original = Tokenizer.prototype.inlineText;
  const nest = (depth: number): Record<string, unknown> =>
    depth === 0 ? { type: 'text', raw: 'x', text: 'x' } : { type: 'text', raw: 'x', text: 'ignorato', tokens: [nest(depth - 1)] };
  const withInlineText = (token: Record<string, unknown>, md = 'qualcosa') => {
    Tokenizer.prototype.inlineText = function (src: string) { return { ...token, raw: src } as never; };
    try { return markdownToDoc(md).content; } finally { Tokenizer.prototype.inlineText = original; }
  };
  // figli presenti: si convertono i figli (con i loro marchi), non il testo del token
  assert.deepEqual(withInlineText({ type: 'text', text: 'ignorato', tokens: [
    { type: 'strong', raw: 'y', text: 'y', tokens: [{ type: 'text', raw: 'y', text: 'y' }] }] }),
  [para(text('y', [{ type: 'strong' }]))]);
  // figli vuoti: si usa il testo del token
  assert.deepEqual(withInlineText({ type: 'text', text: 'proprio', tokens: [] }), [para(text('proprio'))]);
  // ogni livello di figli conta per il limite di annidamento
  assert.deepEqual(withInlineText(nest(19)), [para(text('x'))]);
  assert.throws(() => withInlineText(nest(20)), (e: unknown) => e instanceof UsageError && e.message === 'Markdown troppo annidato');
  // un testo vuoto non produce nodi
  assert.throws(() => withInlineText({ type: 'text', text: '' }), (e: unknown) => e instanceof UsageError && e.message === 'Contenuto vuoto');
});

// Il budget di lavoro del tokenizer è un conteggio deterministico: per input piccoli se ne verifica il
// valore esatto (cattura dell'istanza del tokenizer tramite Lexer.prototype.lex). Ogni regola di
// addebito (scansioni fallite di *, _ e ~, token riusciti, testo, lookahead email) ha un caso dedicato.
// Se si aggiorna marked (versione bloccata) questi numeri vanno ricalcolati insieme a emStrongScans/delScans.
test('budget di lavoro: valori esatti per ogni regola di addebito', () => {
  const originalLex = Lexer.prototype.lex;
  let tokenizer: { work: number } | undefined;
  Lexer.prototype.lex = function (this: Lexer, src: string) {
    tokenizer = (this as unknown as { tokenizer: { work: number } }).tokenizer;
    return originalLex.call(this, src);
  };
  const work = (md: string): number => {
    tokenizer = undefined;
    try { markdownToDoc(md); } catch { /* conta anche per input rifiutati dopo il lexing */ }
    return tokenizer!.work;
  };
  try {
    const expected: Record<string, number> = {
      'ab': 4, 'a *b* c': 10, 'a **b** c': 12, 'a ~~b~~ c': 12,
      '*a ': 8, '*a *a ': 19, 'x*a': 10, '(*a': 7,
      'a*!': 9, ' *!': 8, '*!': 7, 'a*! *!': 17, 'é*!': 6, '**!': 12, 'a**!': 14,
      '_a': 6, 'a_a': 8, ' _a': 7, 'x _a': 9, '__a': 13, 'x_!': 9, ' _!': 8, '_!': 7, 'a__!': 14,
      '~~a ': 11, 'a~~!': 12, ' ~~!': 11, '~~!': 10,
      '[x]': 3, 'a [x] b': 8, '!!!': 9, 'a@b': 4, 'a.b@c': 11,
    };
    const actual = Object.fromEntries(Object.keys(expected).map((md) => [md, work(md)]));
    assert.deepEqual(actual, expected);
  } finally {
    Lexer.prototype.lex = originalLex;
  }
});

test('budget di lavoro: scansioni fallite addebitate solo quando marked scansiona davvero', () => {
  const complex = 'Markdown troppo complesso da elaborare (troppi delimitatori *, _, ~ o ! non chiusi): semplifica il testo';
  // scansionati fino in fondo (quadratici): rifiutati già con ~12 KB
  for (const unit of ['*a ', ' _a', '~~a ', ' *!', ' ~~!']) usage(unit.repeat(4000), complex);
  // marked non scansiona (delimitatore dopo una lettera): nessun addebito quadratico, convertiti
  for (const unit of ['a_a ', 'a*! ', 'a~~! ', 'a__! ']) assert.equal(markdownToDoc(unit.repeat(4000)).content.length, 1, unit);
});

test('budget di lavoro: esattamente 3 000 000 è ammesso, un carattere in più no', () => {
  // ' ~~!' x1222 costa 2 997 566; il paragrafo di 1217 "a" porta il totale esattamente al budget.
  const base = ' ~~!'.repeat(1222) + '\n\n';
  assert.equal(markdownToDoc(base + 'a'.repeat(1217)).content.length, 2);
  usage(base + 'a'.repeat(1218), /^Markdown troppo complesso/);
});
