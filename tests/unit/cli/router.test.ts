import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../../src/cli/router.ts';
import { AuthError } from '../../../src/util/errors.ts';
import { registerSecret } from '../../../src/util/redact.ts';
import { testContext } from '../../helpers/context.ts';

test('help e nessun argomento stampano l\'elenco dei comandi ed escono con 0', async () => {
  for (const argv of [[], ['help'], ['--help']]) {
    const ctx = testContext();
    assert.equal(await run(argv, ctx), 0);
    const text = ctx.stdout.join('\n');
    for (const cmd of ['auth guide', 'article draft', 'article publish', 'note add', 'notes run-due', 'generate article']) {
      assert.match(text, new RegExp(cmd));
    }
  }
});

test('comando sconosciuto → 64', async () => {
  const ctx = testContext();
  assert.equal(await run(['foo', 'bar'], ctx), 64);
  assert.match(ctx.stderr.join('\n'), /sconosciuto/);
  assert.equal(await run(['article'], testContext()), 64);
});

test('opzione sconosciuta → 64', async () => {
  const ctx = testContext();
  assert.equal(await run(['auth', 'guide', '--boh'], ctx), 64);
});

test('auth guide stampa la guida', async () => {
  const ctx = testContext();
  assert.equal(await run(['auth', 'guide'], ctx), 0);
  assert.match(ctx.stdout.join('\n'), /substack\.sid/);
});

test('gli errori tipizzati diventano exit code e messaggio su stderr, senza segreti', async () => {
  registerSecret('super-secret-value-123');
  const ctx = testContext({
    env: { SUBSTACK_CLI_CONFIG_DIR: '/nonexistent-dir-xyz' },
    fetchImpl: (async () => { throw new AuthError('token super-secret-value-123 scaduto'); }) as typeof fetch,
  });
  const code = await run(['auth', 'check'], ctx);
  assert.equal(code, 2); // cookie non configurato → AuthError
  assert.ok(!ctx.stderr.join('\n').includes('super-secret-value-123'));
});
