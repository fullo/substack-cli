import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkdown, generateArticle, generateNote, InvalidOutputError, slugify } from '../../../src/generate/generate.ts';
import type { Provider } from '../../../src/generate/provider.ts';

const stub = (text: string, seen: { prompt?: string; system?: string } = {}): Provider => ({
  async generate(req) { seen.prompt = req.prompt; seen.system = req.system; return text; },
});

test('extractMarkdown toglie il recinto ```markdown e gli spazi', () => {
  assert.equal(extractMarkdown('```markdown\n# Ciao\n```\n'), '# Ciao');
  assert.equal(extractMarkdown('```md\nA\n```'), 'A');
  assert.equal(extractMarkdown('  testo normale \n'), 'testo normale');
  assert.equal(extractMarkdown('```js\ncodice\n```'), '```js\ncodice\n```'); // un blocco di codice vero resta
});

test('generateArticle: prompt con argomento e lingua, output validato', async () => {
  const seen: { prompt?: string; system?: string } = {};
  const out = '---\ntitle: Titolo\n---\n\nCorpo.';
  const r = await generateArticle(stub(out, seen), { topic: 'Rust', lang: 'it', maxTokens: 500 });
  assert.equal(r.article.frontMatter.title, 'Titolo');
  assert.equal(r.markdown, out);
  assert.match(seen.prompt ?? '', /Rust/);
  assert.match(seen.prompt ?? '', /it/);
  assert.match(seen.system ?? '', /front-matter/i);
});

test('generateArticle: output non valido → InvalidOutputError con il testo grezzo', async () => {
  await assert.rejects(
    generateArticle(stub('Nessun front-matter'), { topic: 't', lang: 'it', maxTokens: 10 }),
    (e: Error) => e instanceof InvalidOutputError && e.raw === 'Nessun front-matter',
  );
  await assert.rejects(
    generateArticle(stub('---\ntitle: T\n---\n\n<script>x</script>'), { topic: 't', lang: 'it', maxTokens: 10 }),
    InvalidOutputError,
  );
});

test('generateNote: testo validato come Markdown', async () => {
  assert.equal(await generateNote(stub('Una nota **breve**'), { topic: 't', lang: 'it', maxTokens: 10 }), 'Una nota **breve**');
  await assert.rejects(generateNote(stub('<b>no</b>'), { topic: 't', lang: 'it', maxTokens: 10 }), InvalidOutputError);
  await assert.rejects(generateNote(stub('x'.repeat(5001)), { topic: 't', lang: 'it', maxTokens: 10 }), InvalidOutputError);
});

test('slugify produce nomi file sicuri', () => {
  assert.equal(slugify('Ciao Mondo! È già così?'), 'ciao-mondo-e-gia-cosi');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugify('!!!'), 'bozza');
  assert.equal(slugify('a'.repeat(200)).length, 60);
});
