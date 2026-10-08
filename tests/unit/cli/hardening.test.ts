// Revisione di sicurezza (F10): prompt nascosto con stdin da terminale, errori di config.json senza
// contenuto del file, avviso visibile quando l'orologio di test è attivo, guida senza cookie in chiaro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../../../src/cli/router.ts';
import { loadConfig } from '../../../src/config/config.ts';
import { AUTH_GUIDE } from '../../../src/auth/guide.ts';
import { UsageError } from '../../../src/util/errors.ts';
import { testContext } from '../../helpers/context.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const SID = 's%3AhiddenPromptCookie1234567890.sig';

test('auth set: con stdin da terminale usa il prompt nascosto anche se stdout non è un terminale', async () => {
  await withTmpDir(async (dir) => {
    const prompts: { question: string; hidden: boolean }[] = [];
    let stdinRead = false;
    const ctx = testContext({
      env: { SUBSTACK_CLI_CONFIG_DIR: dir },
      isInteractive: false,
      stdinIsTTY: true,
      prompt: async (question, opts) => { prompts.push({ question, hidden: opts?.hidden === true }); return SID; },
      readStdin: async () => { stdinRead = true; return ''; },
    });
    assert.equal(await run(['auth', 'set', '--no-check'], ctx), 0, ctx.stderr.join('\n'));
    assert.equal(stdinRead, false);
    assert.deepEqual(prompts.map((p) => p.hidden), [true]);
    assert.equal(JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')).sid, SID);
  });
});

test('auth set: stdin non da terminale (pipe) legge da stdin senza prompt', async () => {
  await withTmpDir(async (dir) => {
    let prompted = false;
    const ctx = testContext({
      env: { SUBSTACK_CLI_CONFIG_DIR: dir }, isInteractive: false, stdinIsTTY: false,
      prompt: async () => { prompted = true; return ''; }, readStdin: async () => `${SID}\n`,
    });
    assert.equal(await run(['auth', 'set', '--no-check'], ctx), 0, ctx.stderr.join('\n'));
    assert.equal(prompted, false);
  });
});

test('config.json non valido: il messaggio riporta solo la posizione, mai il contenuto del file', async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, 'config.json');
    for (const [content, where] of [
      ['segreto=1', undefined],
      ['{"publication": "p", segreto-nel-posto-sbagliato}', 'riga 1, colonna 22'],
      ['{\n  "publication": "p"\n  "segreto-nel-posto-sbagliato": 1\n}', 'riga 3, colonna 3'],
    ] as const) {
      await writeFile(file, content);
      await assert.rejects(loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir }), (e: unknown) => {
        assert.ok(e instanceof UsageError);
        assert.ok(!e.message.includes('segreto'), e.message);
        assert.ok(!e.message.includes('SUBSTACK_SID'), e.message);
        assert.ok(e.message.startsWith(`config.json non è JSON valido (${file})`), e.message);
        if (where) assert.ok(e.message.endsWith(where), e.message);
        return true;
      }, content);
    }
  });
});

test('orologio di test attivo: avviso visibile su stderr a ogni comando', async () => {
  const active = testContext({ env: { SUBSTACK_ALLOW_TEST_CLOCK: '1', SUBSTACK_NOW: '2030-01-01T00:00:00Z' } });
  assert.equal(await run(['auth', 'guide'], active), 0);
  assert.match(active.stderr.join('\n'), /orologio di test.*2030-01-01T00:00:00\.000Z/i);
  for (const env of [
    { SUBSTACK_NOW: '2030-01-01T00:00:00Z' },
    { SUBSTACK_ALLOW_TEST_CLOCK: '1' },
    { SUBSTACK_ALLOW_TEST_CLOCK: '1', SUBSTACK_NOW: 'non una data' },
    { SUBSTACK_ALLOW_TEST_CLOCK: 'true', SUBSTACK_NOW: '2030-01-01T00:00:00Z' },
  ]) {
    const ctx = testContext({ env });
    assert.equal(await run(['auth', 'guide'], ctx), 0);
    assert.deepEqual(ctx.stderr, [], JSON.stringify(env));
  }
});

test('guida e README: nessun esempio con il cookie in chiaro su riga di comando, stesse istruzioni', async () => {
  const readme = await readFile('README.md', 'utf8');
  for (const [name, text] of [['AUTH_GUIDE', AUTH_GUIDE], ['README', readme]] as const) {
    assert.ok(!/--from-literal=SUBSTACK_SID/.test(text), `${name}: --from-literal con il cookie`);
    assert.ok(!/echo ['"]?SUBSTACK_SID=/.test(text), `${name}: echo del cookie`);
    assert.ok(!/printf '%s' "<valore>"/.test(text), `${name}: cookie letterale in printf`);
    assert.ok(!/export SUBSTACK_SID="<valore>"/.test(text), `${name}: cookie letterale in export`);
    for (const snippet of ['read -rs SID', 'printf \'%s\' "$SID" | substack auth set', '--from-file=SUBSTACK_SID=/dev/stdin']) {
      assert.ok(text.includes(snippet), `${name}: manca ${snippet}`);
    }
  }
});
