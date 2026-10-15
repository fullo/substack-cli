import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docToMarkdown } from '../../../src/markdown/export.ts';
import { markdownToDoc } from '../../../src/markdown/prosemirror.ts';

test('docToMarkdown: round-trip dei costrutti che il CLI sa scrivere', () => {
  const src = [
    '## Titolo',
    'Testo con **grassetto**, *corsivo*, `codice` e un [link](https://example.com/).',
    '- uno\n- due',
    '1. primo\n2. secondo',
    '> citazione',
    '```js\nconst a = 1;\n```',
    '---',
    '![alt](https://example.com/a.png)',
  ].join('\n\n');
  const { markdown, unsupported } = docToMarkdown(markdownToDoc(src));
  assert.deepEqual(unsupported, []);
  assert.deepEqual(markdownToDoc(markdown), markdownToDoc(src));
});

test('docToMarkdown: nodi sconosciuti diventano un commento e vengono segnalati', () => {
  const r = docToMarkdown({ type: 'doc', content: [{ type: 'subscribeWidget' }, { type: 'paragraph', content: [{ type: 'text', text: 'ciao' }] }] });
  assert.match(r.markdown, /<!-- substack: subscribeWidget non esportato -->/);
  assert.match(r.markdown, /ciao/);
  assert.deepEqual(r.unsupported, ['subscribeWidget']);
});

test('docToMarkdown: link con schema non consentito e immagini non https sono scartati', () => {
  const r = docToMarkdown({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
    { type: 'captionedImage', content: [{ type: 'image2', attrs: { src: 'http://example.com/a.png', alt: null } }] },
  ] });
  assert.equal(r.markdown, 'x');
});

test('docToMarkdown: i caratteri speciali nel testo sono protetti', () => {
  const r = docToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '*non* corsivo_' }] }] });
  assert.equal(r.markdown, '\\*non\\* corsivo\\_');
});
