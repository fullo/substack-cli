import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../../src/cli/router.ts';
import { testContext } from '../../helpers/context.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call } from '../../helpers/fetch.ts';

const ENV = { SUBSTACK_SID: 's%3AunitTestCookie1234567890.sig', SUBSTACK_BASE_URL: 'http://127.0.0.1:9', SUBSTACK_PUBLICATION: 'p',
  SUBSTACK_CLI_CONFIG_DIR: 'Z:/inesistente/substack-cli-test' };

function setup(answer: string) {
  const calls: Call[] = [];
  const questions: string[] = [];
  const fetchImpl = makeFetch((c) => (c.url.endsWith('/api/v1/drafts/7') ? json({ id: 7, draft_title: 'Il mio pezzo' }) : json({})), calls);
  const ctx = testContext({
    env: ENV, isInteractive: true, fetchImpl,
    prompt: async (q) => { questions.push(q); return answer; },
  });
  return { ctx, calls, questions };
}

test('article schedule interattivo: riepilogo (titolo, data, email) e conferma con "programma"', async () => {
  const { ctx, calls, questions } = setup(' Programma \n');
  const code = await run(['article', 'schedule', '7', '--at', '2026-10-09T09:00:00+02:00', '--send-email'], ctx);
  assert.equal(code, 0, ctx.stderr.join('\n'));
  assert.equal(questions.length, 1);
  assert.match(questions[0]!, /"programma"/);
  const summary = ctx.stderr.join('\n');
  assert.match(summary, /Il mio pezzo/);
  assert.match(summary, /2026-10-09T07:00:00\.000Z/);
  assert.match(summary, /email agli iscritti: SÌ/);
  assert.equal(calls.filter((c) => c.url.endsWith('/scheduled_release')).length, 1);
});

test('article schedule interattivo: risposta diversa da "programma" annulla senza schedulare', async () => {
  for (const answer of ['', 'pubblica', 'si', 'yes', 'programmare']) {
    const { ctx, calls } = setup(answer);
    const code = await run(['article', 'schedule', '7', '--at', '2026-10-09T09:00:00+02:00'], ctx);
    assert.equal(code, 64, answer);
    assert.match(ctx.stderr.join('\n'), /email agli iscritti: no/);
    assert.equal(calls.filter((c) => c.url.endsWith('/scheduled_release')).length, 0, answer);
  }
});

test('article schedule --cancel non chiede conferma', async () => {
  const { ctx, calls, questions } = setup('');
  assert.equal(await run(['article', 'schedule', '7', '--cancel'], ctx), 0);
  assert.equal(questions.length, 0);
  assert.equal(calls.filter((c) => c.url.endsWith('/scheduled_release')).length, 1);
});
