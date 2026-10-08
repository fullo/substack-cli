import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicProvider } from '../../../src/generate/anthropic.ts';
import { openaiCompatProvider } from '../../../src/generate/openai-compat.ts';
import { ProviderError } from '../../../src/util/errors.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call } from '../../helpers/fetch.ts';

const REQ = { system: 'sys', prompt: 'ciao', maxTokens: 100 };

test('anthropic: richiesta Messages API e testo estratto', async () => {
  const calls: Call[] = [];
  const p = anthropicProvider({
    apiKey: 'sk-ant-test-key-1234', model: 'claude-sonnet-5-5', timeoutMs: 5000,
    fetchImpl: makeFetch(() => json({ content: [{ type: 'text', text: 'Risposta' }] }), calls),
  });
  assert.equal(await p.generate(REQ), 'Risposta');
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');
  const h = new Headers(calls[0]!.init.headers);
  assert.equal(h.get('x-api-key'), 'sk-ant-test-key-1234');
  assert.equal(h.get('anthropic-version'), '2023-06-01');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body, { model: 'claude-sonnet-5-5', max_tokens: 100, system: 'sys', messages: [{ role: 'user', content: 'ciao' }] });
  assert.equal(calls[0]!.init.redirect, 'error');
});

test('anthropic: errori HTTP e forma errata → ProviderError senza chiave nel messaggio', async () => {
  const mk = (route: () => Response) => anthropicProvider({
    apiKey: 'sk-ant-test-key-1234', model: 'm', timeoutMs: 5000, fetchImpl: makeFetch(route),
  });
  await assert.rejects(mk(() => json({ error: { message: 'sk-ant-test-key-1234 invalida' } }, 401)).generate(REQ),
    (e: Error) => e instanceof ProviderError && !e.message.includes('sk-ant-test-key-1234'));
  await assert.rejects(mk(() => json({ content: [] })).generate(REQ), ProviderError);
  await assert.rejects(mk(() => new Response('non json')).generate(REQ), ProviderError);
});

test('openai-compat: URL, header opzionale, testo estratto', async () => {
  const calls: Call[] = [];
  const p = openaiCompatProvider({
    baseUrl: 'http://llm.local:8080/', model: 'qwen', apiKey: 'k-1234567890', timeoutMs: 5000,
    fetchImpl: makeFetch(() => json({ choices: [{ message: { content: 'Testo' } }] }), calls),
  });
  assert.equal(await p.generate(REQ), 'Testo');
  assert.equal(calls[0]!.url, 'http://llm.local:8080/v1/chat/completions');
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer k-1234567890');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'ciao' }]);
  assert.equal(body.model, 'qwen');
  assert.equal(body.max_tokens, 100);
});

test('openai-compat senza apiKey: nessun header authorization; errori → ProviderError', async () => {
  const calls: Call[] = [];
  const p = openaiCompatProvider({
    baseUrl: 'http://llm.local', model: 'm', timeoutMs: 5000,
    fetchImpl: makeFetch(() => json({ choices: [{ message: { content: 'x' } }] }), calls),
  });
  await p.generate(REQ);
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), null);
  const bad = openaiCompatProvider({ baseUrl: 'http://llm.local', model: 'm', timeoutMs: 5000, fetchImpl: makeFetch(() => json({ choices: [] })) });
  await assert.rejects(bad.generate(REQ), ProviderError);
  const down = openaiCompatProvider({ baseUrl: 'http://llm.local', model: 'm', timeoutMs: 5000, fetchImpl: makeFetch(() => { throw new Error('ECONNREFUSED'); }) });
  await assert.rejects(down.generate(REQ), /ECONNREFUSED/);
});
