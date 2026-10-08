// Test aggiuntivi dall'analisi dei mutanti (Stryker): prompt e messaggi esatti, estrazione del Markdown,
// confini di slugify, richieste ai provider (metodo, timeout, URL), errori dei provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkdown, generateArticle, generateNote, InvalidOutputError, slugify } from '../../../src/generate/generate.ts';
import type { GenerateRequest, Provider } from '../../../src/generate/provider.ts';
import { anthropicProvider } from '../../../src/generate/anthropic.ts';
import { openaiCompatProvider } from '../../../src/generate/openai-compat.ts';
import { ProviderError } from '../../../src/util/errors.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call } from '../../helpers/fetch.ts';

const capture = (text: string, seen: GenerateRequest[]): Provider => ({
  async generate(req) { seen.push(req); return text; },
});
const OPTS = { topic: 'Rust', lang: 'en', maxTokens: 321 };

test('generateArticle: richiesta esatta (system, prompt, maxTokens) e articolo restituito', async () => {
  const seen: GenerateRequest[] = [];
  const r = await generateArticle(capture('```markdown\n---\ntitle: T\n---\n\nCorpo\n```', seen), OPTS);
  assert.equal(seen[0]!.prompt, 'Scrivi un articolo in lingua "en" sul tema: Rust');
  assert.equal(seen[0]!.maxTokens, 321);
  assert.equal(seen[0]!.system, `Sei un redattore di newsletter. Rispondi SOLO con un documento Markdown.
Il documento inizia con un front-matter YAML (--- title: ... subtitle: ... ---) seguito dal corpo.
Nel corpo usa solo: titoli ## e ###, paragrafi, **grassetto**, *corsivo*, liste, citazioni, link https, blocchi di codice.
Non usare HTML, tabelle, task list, immagini inline né testo fuori dal documento.`);
  assert.equal(r.markdown, '---\ntitle: T\n---\n\nCorpo');
  assert.equal(r.article.frontMatter.title, 'T');
});

test('generateArticle: messaggio di InvalidOutputError con la causa', async () => {
  await assert.rejects(generateArticle(capture('niente', []), OPTS), (e: unknown) => e instanceof InvalidOutputError &&
    e instanceof ProviderError && e.raw === 'niente' &&
    e.message === "L'output generato non è un articolo valido: Front-matter mancante: il file deve iniziare con \"---\" e contenere almeno \"title\"");
});

test('generateNote: richiesta esatta, recinto tolto, limite di 5000 caratteri incluso', async () => {
  const seen: GenerateRequest[] = [];
  assert.equal(await generateNote(capture('```md\nNota\n```', seen), OPTS), 'Nota');
  assert.equal(seen[0]!.prompt, 'Scrivi una nota in lingua "en" sul tema: Rust');
  assert.equal(seen[0]!.maxTokens, 321);
  assert.equal(seen[0]!.system, `Scrivi una nota breve (massimo 600 caratteri) per un social di newsletter.
Rispondi SOLO con il testo della nota, in Markdown semplice (paragrafi, **grassetto**, *corsivo*, link https). Niente HTML.`);
  assert.equal((await generateNote(capture('x'.repeat(5000), []), OPTS)).length, 5000);
  await assert.rejects(generateNote(capture('x'.repeat(5001), []), OPTS), (e: unknown) => e instanceof InvalidOutputError &&
    e.message === "L'output generato non è una nota valida: la nota supera i 5000 caratteri" && e.raw === 'x'.repeat(5001));
  await assert.rejects(generateNote(capture('~~x~~', []), OPTS), (e: unknown) => e instanceof InvalidOutputError &&
    e.message.startsWith("L'output generato non è una nota valida: Markdown non supportato (inline): "));
});

test('extractMarkdown: recinto solo se occupa tutto il testo; contenuto interno ripulito', () => {
  assert.equal(extractMarkdown('```markdown\n  A  \n```'), 'A');
  assert.equal(extractMarkdown('```md\nA\nB\n```'), 'A\nB');
  assert.equal(extractMarkdown('prima\n```md\nA\n```'), 'prima\n```md\nA\n```');
  assert.equal(extractMarkdown('```md\nA\n```\ndopo'), '```md\nA\n```\ndopo');
  assert.equal(extractMarkdown('```mdx\nA\n```'), '```mdx\nA\n```');
  assert.equal(extractMarkdown('```md A\n```'), '```md A\n```');
  assert.equal(extractMarkdown('```md\n\n```'), '');
});

test('slugify: accenti, trattini ai bordi, troncamento a 60 senza trattino finale', () => {
  assert.equal(slugify('--Ciao--'), 'ciao');
  assert.equal(slugify('àèìòù ÀÉ'), 'aeiou-ae');
  assert.equal(slugify('a'.repeat(59) + ' b'), 'a'.repeat(59));
  assert.equal(slugify('a'.repeat(58) + '---b'), 'a'.repeat(58) + '-b');
  assert.equal(slugify('A1 b2'), 'a1-b2');
  assert.equal(slugify(''), 'bozza');
  assert.equal(slugify('ÿ'), 'y');
});

test('anthropic: POST, timeout, baseUrl personalizzato con barre finali, testo concatenato', async () => {
  const calls: Call[] = [];
  const seen: number[] = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => { seen.push(ms); return original.call(AbortSignal, ms); };
  try {
    const p = anthropicProvider({
      apiKey: 'k-12345678', model: 'm', timeoutMs: 4321, baseUrl: 'http://proxy.local//',
      fetchImpl: makeFetch(() => json({ content: [{ type: 'text', text: 'A' }, { type: 'tool_use' }, { type: 'text', text: 'B' }] }), calls),
    });
    assert.equal(await p.generate({ system: 's', prompt: 'p', maxTokens: 1 }), 'AB');
  } finally {
    AbortSignal.timeout = original;
  }
  assert.equal(calls[0]!.url, 'http://proxy.local/v1/messages');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(new Headers(calls[0]!.init.headers).get('content-type'), 'application/json');
  assert.deepEqual(seen, [4321]);
});

test('anthropic: messaggi d\'errore esatti', async () => {
  const mk = (route: () => Response) => anthropicProvider({ apiKey: 'k-12345678', model: 'm', timeoutMs: 1000, fetchImpl: makeFetch(route) });
  const REQ = { system: 's', prompt: 'p', maxTokens: 1 };
  await assert.rejects(mk(() => { throw new Error('ECONNRESET'); }).generate(REQ), (e: unknown) =>
    e instanceof ProviderError && e.message === 'Chiamata ad Anthropic fallita: ECONNRESET');
  await assert.rejects(mk(() => json({}, 500)).generate(REQ), (e: unknown) =>
    e instanceof ProviderError && e.message === 'Anthropic ha risposto con stato 500');
  await assert.rejects(mk(() => new Response('x')).generate(REQ), (e: unknown) =>
    e instanceof ProviderError && e.message === 'Risposta di Anthropic non JSON');
  for (const body of [{ content: [] }, { content: [{ type: 'text' }] }, { content: [{ type: 'text', text: '' }] }, { nope: 1 },
    { content: [{ type: 'text', text: 5 }] }, { content: [{ text: 'senza tipo' }] }]) {
    await assert.rejects(mk(() => json(body)).generate(REQ), (e: unknown) =>
      e instanceof ProviderError && e.message === 'Risposta di Anthropic senza testo', JSON.stringify(body));
  }
});

test('openai-compat: POST, timeout, barre finali, messaggi d\'errore esatti', async () => {
  const calls: Call[] = [];
  const seen: number[] = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => { seen.push(ms); return original.call(AbortSignal, ms); };
  try {
    const p = openaiCompatProvider({ baseUrl: 'http://h:1///', model: 'm', timeoutMs: 777,
      fetchImpl: makeFetch(() => json({ choices: [{ message: { content: 'T' } }, { message: { content: 'U' } }] }), calls) });
    assert.equal(await p.generate({ system: 's', prompt: 'p', maxTokens: 1 }), 'T');
  } finally {
    AbortSignal.timeout = original;
  }
  assert.equal(calls[0]!.url, 'http://h:1/v1/chat/completions');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.equal(new Headers(calls[0]!.init.headers).get('content-type'), 'application/json');
  assert.deepEqual(seen, [777]);

  const mk = (route: () => Response, apiKey?: string) =>
    openaiCompatProvider({ baseUrl: 'http://h', model: 'm', timeoutMs: 1000, apiKey, fetchImpl: makeFetch(route) });
  const REQ = { system: 's', prompt: 'p', maxTokens: 1 };
  await assert.rejects(mk(() => { throw new Error('ECONNREFUSED'); }).generate(REQ), (e: unknown) =>
    e instanceof ProviderError && e.message === 'Chiamata al server LLM fallita: ECONNREFUSED');
  await assert.rejects(mk(() => json({}, 404)).generate(REQ), (e: unknown) =>
    e instanceof ProviderError && e.message === 'Il server LLM ha risposto con stato 404');
  await assert.rejects(mk(() => new Response('x')).generate(REQ), (e: unknown) =>
    e instanceof ProviderError && e.message === 'Risposta del server LLM non JSON');
  for (const body of [{ choices: [] }, { choices: [{ message: { content: null } }] }, { choices: [{ message: { content: '' } }] }, {},
    { choices: [{}] }, { choices: [{ message: { content: 5 } }] }, { choices: [{ message: {} }] }]) {
    await assert.rejects(mk(() => json(body)).generate(REQ), (e: unknown) =>
      e instanceof ProviderError && e.message === 'Risposta del server LLM senza testo', JSON.stringify(body));
  }
  const calls2: Call[] = [];
  await openaiCompatProvider({ baseUrl: 'http://h', model: 'm', timeoutMs: 1000, apiKey: '',
    fetchImpl: makeFetch(() => json({ choices: [{ message: { content: 'x' } }] }), calls2) }).generate(REQ);
  assert.equal(new Headers(calls2[0]!.init.headers).get('authorization'), null);
});
