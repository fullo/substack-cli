import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../../src/cli/router.ts';
import { testContext } from '../../helpers/context.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call } from '../../helpers/fetch.ts';

const ENV = { SUBSTACK_SID: 's%3AunitTestCookie1234567890.sig', SUBSTACK_BASE_URL: 'http://127.0.0.1:9', SUBSTACK_PUBLICATION: 'p',
  SUBSTACK_CLI_CONFIG_DIR: 'Z:/inesistente/substack-cli-test' };

test('article update interattivo: riepilogo una sola volta (stderr), poi solo l\'esito su stdout', async () => {
  let title = 'Vecchio';
  const calls: Call[] = [];
  const fetchImpl = makeFetch((c) => {
    if (c.url.endsWith('/api/v1/drafts/7') && c.init.method === 'PUT') title = JSON.parse(String(c.init.body)).draft_title;
    return json({ id: 7, draft_title: title });
  }, calls);
  const ctx = testContext({ env: ENV, isInteractive: true, fetchImpl, prompt: async () => 'aggiorna' });
  const code = await run(['article', 'update', '7', '--title', 'Nuovo'], ctx);
  assert.equal(code, 0, ctx.stderr.join('\n'));
  assert.match(ctx.stderr.join('\n'), /titolo: "Vecchio" → "Nuovo"/);
  assert.deepEqual(ctx.stdout, ['Bozza 7 aggiornata']);
});
