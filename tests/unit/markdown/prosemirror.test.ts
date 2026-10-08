import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToDoc, unescapeHtml } from '../../../src/markdown/prosemirror.ts';
import { UsageError } from '../../../src/util/errors.ts';

const first = (md: string) => markdownToDoc(md).content[0]!;

test('paragrafo con grassetto, corsivo e codice', () => {
  assert.deepEqual(first('Ciao **mondo**').content, [
    { type: 'text', text: 'Ciao ' },
    { type: 'text', text: 'mondo', marks: [{ type: 'strong' }] },
  ]);
  const p = first('a *b* `c`').content!;
  assert.deepEqual(p[1], { type: 'text', text: 'b', marks: [{ type: 'em' }] });
  assert.deepEqual(p[3], { type: 'text', text: 'c', marks: [{ type: 'code' }] });
});

test('marchi annidati si accumulano', () => {
  const n = first('***x***').content!.flatMap((x) => x.marks ?? []).map((m) => m.type).sort();
  assert.deepEqual(n, ['em', 'strong']);
});

test('titoli h1-h4 con livello; h5 e h6 sono rifiutati', () => {
  const doc = markdownToDoc('# Uno\n\n## Due\n\n#### Quattro');
  assert.deepEqual(doc.content.map((n) => [n.type, n.attrs?.level]), [['heading', 1], ['heading', 2], ['heading', 4]]);
  assert.throws(() => markdownToDoc('##### Cinque'), UsageError);
});

test('liste puntate, numerate e annidate', () => {
  const list = first('- uno\n- due\n  - annidato');
  assert.equal(list.type, 'bullet_list');
  assert.equal(list.content!.length, 2);
  const secondItem = list.content![1]!;
  assert.equal(secondItem.type, 'list_item');
  assert.deepEqual(secondItem.content!.map((n) => n.type), ['paragraph', 'bullet_list']);
  assert.equal(first('1. a\n2. b').type, 'ordered_list');
});

test('citazione, codice, separatore', () => {
  assert.equal(first('> citazione').type, 'blockquote');
  const code = first('```js\nlet x = 1 < 2 && 3;\n```');
  assert.equal(code.type, 'code_block');
  assert.equal(code.attrs?.language, 'js');
  assert.equal(code.content![0]!.text, 'let x = 1 < 2 && 3;');
  assert.equal(first('---').type, 'horizontal_rule');
});

test('le entità HTML introdotte dal lexer vengono ripristinate', () => {
  assert.equal(unescapeHtml('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), `a & b <c> "d" 'e'`);
  assert.equal(unescapeHtml('&amp;lt;'), '&lt;');
  assert.equal(first('A & B < C "q"').content![0]!.text, 'A & B < C "q"');
  assert.equal(first('`<b>&</b>`').content![0]!.text, '<b>&</b>');
});

test('link: ammessi http, https, mailto; vietati gli altri schemi e i relativi', () => {
  const link = first('[sito](https://example.com/a)').content![0]!;
  assert.deepEqual(link.marks, [{ type: 'link', attrs: { href: 'https://example.com/a' } }]);
  assert.ok(first('[m](mailto:a@b.it)').content![0]!.marks);
  for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html;base64,AAAA)', '[x](ftp://a.b)',
    '[x](/relativo)', '[x](file:///etc/passwd)', '[x](JaVaScRiPt:alert(1))']) {
    assert.throws(() => markdownToDoc(bad), UsageError, bad);
  }
});

test('immagine su paragrafo a sé, solo https; inline o http rifiutate', () => {
  const img = first('![testo alt](https://example.com/i.png)');
  assert.equal(img.type, 'captionedImage');
  assert.equal(JSON.stringify(img).includes('https://example.com/i.png'), true);
  assert.throws(() => markdownToDoc('![a](http://example.com/i.png)'), UsageError);
  assert.throws(() => markdownToDoc('testo ![a](https://example.com/i.png) altro'), UsageError);
  assert.throws(() => markdownToDoc('![a](javascript:alert(1))'), UsageError);
});

test('HTML grezzo, tabelle e task list sono errori espliciti', () => {
  assert.throws(() => markdownToDoc('<script>alert(1)</script>'), UsageError);
  assert.throws(() => markdownToDoc('ciao <b>x</b>'), UsageError);
  assert.throws(() => markdownToDoc('| a | b |\n|---|---|\n| 1 | 2 |'), UsageError);
  assert.throws(() => markdownToDoc('- [ ] da fare'), UsageError);
});

test('contenuto vuoto, caratteri di controllo e bidi sono rifiutati', () => {
  assert.throws(() => markdownToDoc(''), UsageError);
  assert.throws(() => markdownToDoc('   \n\n'), UsageError);
  assert.throws(() => markdownToDoc('a\u0000b'), UsageError);
  assert.throws(() => markdownToDoc('a‮b'), UsageError);
  assert.equal(markdownToDoc('a\tb\nc').content.length, 1); // tab e a capo sono ammessi
});

test('limiti: annidamento eccessivo e input enorme', () => {
  const deep = Array.from({ length: 60 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n');
  assert.throws(() => markdownToDoc(deep), UsageError);
  assert.throws(() => markdownToDoc('a'.repeat(1_000_001)), UsageError);
  assert.throws(() => markdownToDoc('> '.repeat(60) + 'x'), UsageError);
});
