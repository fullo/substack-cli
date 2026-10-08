// Corpo delle risposte HTTP: limite di dimensione anche per i provider LLM, e timeout/interruzioni
// durante la lettura del corpo mappati su errori tipizzati (NetworkError per Substack, ProviderError per l'LLM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { SubstackClient } from '../../../src/substack/client.ts';
import { anthropicProvider } from '../../../src/generate/anthropic.ts';
import { openaiCompatProvider } from '../../../src/generate/openai-compat.ts';
import { NetworkError, ProviderError } from '../../../src/util/errors.ts';
import { FakeServer } from '../../helpers/fake-server.ts';
import { makeFetch } from '../../helpers/fetch.ts';

const SID = 's%3AabcdefGHIJKLmnop1234567890.signature';
const REQ = { system: 's', prompt: 'p', maxTokens: 10 };

/** Server che invia gli header e un pezzo di corpo, poi resta fermo (non chiude mai la risposta). */
function stall(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write('{"id":');
}

/** Corpo chunked infinito (fino a 50 MB) generato su richiesta: conta i byte effettivamente letti. */
function endless() {
  const state = { produced: 0, cancelled: false };
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.produced >= 50_000_000) { controller.close(); return; }
      state.produced += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, response: () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }) };
}

test('SubstackClient: corpo che si blocca oltre il timeout → NetworkError (exit 4) e GET riprovata', async () => {
  const server = await FakeServer.start((_req, res) => stall(res));
  try {
    const client = new SubstackClient({
      sid: SID, publicationUrl: server.url, globalUrl: server.url, timeoutMs: 150, maxAttempts: 2, sleep: async () => undefined,
    });
    await assert.rejects(client.getProfile(), (e: unknown) => e instanceof NetworkError && e.exitCode === 4 && /interrott/.test(e.message));
    assert.equal(server.requests.length, 2);
  } finally { await server.stop(); }
});

test('SubstackClient: corpo bloccato su POST non idempotente → NetworkError, nessun nuovo tentativo', async () => {
  const server = await FakeServer.start((_req, res) => stall(res));
  try {
    const client = new SubstackClient({
      sid: SID, publicationUrl: server.url, globalUrl: server.url, timeoutMs: 150, maxAttempts: 3, sleep: async () => undefined,
    });
    await assert.rejects(client.postNote({ type: 'doc', content: [] }), NetworkError);
    assert.equal(server.requests.length, 1);
  } finally { await server.stop(); }
});

test('openai-compat: corpo bloccato oltre il timeout → ProviderError (exit 5) che parla di interruzione', async () => {
  const server = await FakeServer.start((_req, res) => stall(res));
  try {
    const p = openaiCompatProvider({ baseUrl: server.url, model: 'm', timeoutMs: 150 });
    await assert.rejects(p.generate(REQ), (e: unknown) => e instanceof ProviderError && e.exitCode === 5 && /interrott/.test(e.message));
  } finally { await server.stop(); }
});

test('anthropic: corpo bloccato oltre il timeout → ProviderError', async () => {
  const server = await FakeServer.start((_req, res) => stall(res));
  try {
    const p = anthropicProvider({ apiKey: 'sk-ant-test-123456', model: 'm', timeoutMs: 150, baseUrl: server.url });
    await assert.rejects(p.generate(REQ), (e: unknown) => e instanceof ProviderError && /interrott/.test(e.message));
  } finally { await server.stop(); }
});

for (const [name, make] of [
  ['openai-compat', (f: typeof fetch) => openaiCompatProvider({ baseUrl: 'http://llm.local', model: 'm', timeoutMs: 5000, fetchImpl: f })],
  ['anthropic', (f: typeof fetch) => anthropicProvider({ apiKey: 'sk-ant-test-123456', model: 'm', timeoutMs: 5000, fetchImpl: f })],
] as const) {
  test(`${name}: risposta chunked oltre 5 MB → ProviderError, lettura interrotta subito dopo il limite`, async () => {
    const { state, response } = endless();
    await assert.rejects(make(makeFetch(response)).generate(REQ), (e: unknown) => e instanceof ProviderError && /troppo grande/.test(e.message));
    assert.ok(state.produced <= 5_000_000 + 2 * 64 * 1024, `byte letti: ${state.produced}`);
    assert.equal(state.cancelled, true);
  });

  test(`${name}: content-length dichiarato oltre 5 MB → ProviderError senza leggere il corpo`, async () => {
    const { state, response } = endless();
    const res = response();
    const declared = new Response(res.body, { status: 200, headers: { 'content-length': '6000000' } });
    await assert.rejects(make(makeFetch(() => declared)).generate(REQ), (e: unknown) => e instanceof ProviderError && /troppo grande/.test(e.message));
    assert.equal(state.produced, 0);
  });
}

test('content-length oltre il limite e corpo assente: rifiutato senza errori interni', async () => {
  const p = openaiCompatProvider({
    baseUrl: 'http://llm.local', model: 'm', timeoutMs: 5000,
    fetchImpl: makeFetch(() => new Response(null, { status: 200, headers: { 'content-length': '6000000' } })),
  });
  await assert.rejects(p.generate(REQ), (e: unknown) => e instanceof ProviderError && /troppo grande/.test(e.message));
});
