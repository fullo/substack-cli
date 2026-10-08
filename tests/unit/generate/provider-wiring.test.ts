import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { buildProvider } from '../../../src/cli/commands/generate.ts';
import { validateConfig } from '../../../src/config/config.ts';
import { UsageError } from '../../../src/util/errors.ts';
import { testContext } from '../../helpers/context.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call } from '../../helpers/fetch.ts';

// Cartella di config inesistente: il test non legge mai i segreti reali dell'utente.
const NO_SECRETS = { SUBSTACK_CLI_CONFIG_DIR: join(tmpdir(), 'substack-cli-assente-' + process.pid) };
const REQ = { system: 's', prompt: 'p', maxTokens: 10 };
const answer = () => json({ content: [{ type: 'text', text: 'ok' }] });

test('anthropic ignora generate.baseUrl: la chiave va solo a https://api.anthropic.com', async () => {
  const calls: Call[] = [];
  const ctx = testContext({ env: { ...NO_SECRETS, ANTHROPIC_API_KEY: 'sk-ant-unit-123456' }, fetchImpl: makeFetch(answer, calls) });
  const config = validateConfig({ generate: { provider: 'openai-compat', baseUrl: 'http://llm.lan:8080' } });
  const p = await buildProvider(ctx, config, 'anthropic');
  assert.equal(await p.generate(REQ), 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');
});

test('anthropic usa generate.anthropicBaseUrl se impostato (solo https://api.anthropic.com)', async () => {
  const calls: Call[] = [];
  const ctx = testContext({ env: { ...NO_SECRETS, ANTHROPIC_API_KEY: 'sk-ant-unit-123456' }, fetchImpl: makeFetch(answer, calls) });
  const config = validateConfig({ generate: { baseUrl: 'http://llm.lan:8080', anthropicBaseUrl: 'https://api.anthropic.com/' } });
  await (await buildProvider(ctx, config, undefined)).generate(REQ);
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');
});

test('openai-compat continua a usare generate.baseUrl', async () => {
  const calls: Call[] = [];
  const ctx = testContext({ env: NO_SECRETS, fetchImpl: makeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }), calls) });
  const config = validateConfig({ generate: { provider: 'openai-compat', baseUrl: 'http://llm.lan:8080' } });
  await (await buildProvider(ctx, config, undefined)).generate(REQ);
  assert.equal(calls[0]!.url, 'http://llm.lan:8080/v1/chat/completions');
});

test('generate.anthropicBaseUrl: ammesso solo https con host esattamente api.anthropic.com', () => {
  for (const ok of ['https://api.anthropic.com', 'https://api.anthropic.com/', 'https://API.anthropic.com']) {
    assert.equal(typeof validateConfig({ generate: { anthropicBaseUrl: ok } }).generate.anthropicBaseUrl, 'string', ok);
  }
  for (const bad of [
    'http://api.anthropic.com', 'https://api.anthropic.com.evil.com', 'https://evil.com', 'https://anthropic.com',
    'https://x.api.anthropic.com', 'https://u:p@api.anthropic.com', 'https://api.anthropic.com:8443', 'http://127.0.0.1:8080',
    'https://api.anthropic.com/v1?x=1', 'non un url', '',
  ]) {
    assert.throws(() => validateConfig({ generate: { anthropicBaseUrl: bad } }),
      (e: unknown) => e instanceof UsageError && e.message.includes('generate.anthropicBaseUrl'), bad);
  }
});
