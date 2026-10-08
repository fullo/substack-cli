// Test aggiuntivi dall'analisi dei mutanti (Stryker): percorsi esatti, confini dei campi numerici e del
// subdomain, messaggi d'errore, precedenza delle variabili d'ambiente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDir, dataDir, globalUrl, loadConfig, publicationUrl } from '../../../src/config/config.ts';
import { UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

test('percorsi di default esatti sotto la home', () => {
  assert.equal(configDir({}), join(homedir(), '.config', 'substack-cli'));
  assert.equal(dataDir({}), join(homedir(), '.local', 'share', 'substack-cli'));
});

test('SUBSTACK_CLI_CONFIG indica direttamente il file; default <configDir>/config.json', async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, 'altro.json');
    await writeFile(file, JSON.stringify({ publication: 'dafile' }));
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publication: 'default' }));
    assert.equal((await loadConfig({ SUBSTACK_CLI_CONFIG: file, SUBSTACK_CLI_CONFIG_DIR: dir })).publication, 'dafile');
    assert.equal((await loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir })).publication, 'default');
  });
});

test('JSON non valido: messaggio con percorso e dettaglio', async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, 'config.json');
    await writeFile(file, '{ rotto');
    await assert.rejects(loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir }), (e: unknown) =>
      e instanceof UsageError && e.message.startsWith(`config.json non è JSON valido (${file}): `) && e.message.length > `config.json non è JSON valido (${file}): `.length);
  });
});

test('validazione: messaggio esatto con percorso del campo e più problemi separati da "; "', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publication: '-x', generate: { maxTokens: 0 } }));
    await assert.rejects(loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir }), (e: unknown) => e instanceof UsageError &&
      e.message === 'Configurazione non valida: publication: subdomain non valido; generate.maxTokens: Number must be greater than or equal to 1');
    await writeFile(join(dir, 'config.json'), JSON.stringify({ x: 1 }));
    await assert.rejects(loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir }), /^UsageError: Configurazione non valida: \(radice\): Unrecognized key/);
    await writeFile(join(dir, 'config.json'), JSON.stringify({ generate: { x: 1 } }));
    await assert.rejects(loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir }), /generate: Unrecognized key/);
    await assert.rejects(loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_BASE_URL: 'https://example.com' }), (e: unknown) =>
      e instanceof UsageError && e.message.includes('baseUrl: baseUrl deve essere https://substack.com o https://*.substack.com (http solo su localhost), senza credenziali'));
  });
});

test('generate: default completi e confini di maxTokens, timeoutMs, model, provider', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.deepEqual((await loadConfig(env)).generate, { provider: 'anthropic', model: 'claude-sonnet-5-5', maxTokens: 4096, timeoutMs: 120000 });
    const gen = (g: Record<string, unknown>) => writeFile(join(dir, 'config.json'), JSON.stringify({ generate: g }));
    for (const ok of [{ maxTokens: 1 }, { maxTokens: 64000 }, { timeoutMs: 1000 }, { timeoutMs: 600000 }, { model: 'x' },
      { provider: 'openai-compat' }]) {
      await gen(ok);
      const g = (await loadConfig(env)).generate as Record<string, unknown>;
      for (const [k, v] of Object.entries(ok)) assert.equal(g[k], v, JSON.stringify(ok));
    }
    for (const bad of [{ maxTokens: 0 }, { maxTokens: 64001 }, { maxTokens: 1.5 }, { timeoutMs: 999 }, { timeoutMs: 600001 },
      { timeoutMs: 1000.5 }, { model: '' }, { provider: 'altro' }]) {
      await gen(bad);
      await assert.rejects(loadConfig(env), UsageError, JSON.stringify(bad));
    }
  });
});

test('publication: subdomain di 1..63 caratteri minuscoli, cifre e trattini, non iniziale', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    for (const ok of ['a', '0', 'a-b', 'a'.repeat(63), '9x-']) {
      assert.equal((await loadConfig({ ...env, SUBSTACK_PUBLICATION: ok })).publication, ok);
    }
    for (const bad of ['a'.repeat(64), '-a', 'A', 'a_b', 'a.b', 'xA', 'a b']) {
      await assert.rejects(loadConfig({ ...env, SUBSTACK_PUBLICATION: bad }), UsageError, bad);
    }
  });
});

test('env: SUBSTACK_PUBLICATION/SUBSTACK_BASE_URL vuote non sovrascrivono il file', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publication: 'p', baseUrl: 'https://p.substack.com' }));
    const cfg = await loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_PUBLICATION: '', SUBSTACK_BASE_URL: '' });
    assert.equal(cfg.publication, 'p');
    assert.equal(cfg.baseUrl, 'https://p.substack.com');
    const cfg2 = await loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_BASE_URL: 'https://q.substack.com' });
    assert.equal(cfg2.baseUrl, 'https://q.substack.com');
    assert.equal(cfg2.publication, 'p');
  });
});

test('baseUrl: host maiuscolo normalizzato, credenziali vuote, porta https', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.equal((await loadConfig({ ...env, SUBSTACK_BASE_URL: 'https://FOO.Substack.com' })).baseUrl, 'https://FOO.Substack.com');
    assert.equal((await loadConfig({ ...env, SUBSTACK_BASE_URL: 'https://substack.com:8443/x' })).baseUrl, 'https://substack.com:8443/x');
    for (const bad of ['https://:pass@substack.com', 'http://:p@localhost:1', 'http://localhost.evil.com', 'http://127.0.0.2:1',
      'https://localhost', 'https://127.0.0.1', 'ftp://localhost:1', 'ws://127.0.0.1:1', 'file://localhost/x']) {
      await assert.rejects(loadConfig({ ...env, SUBSTACK_BASE_URL: bad }), UsageError, bad);
    }
    await writeFile(join(dir, 'config.json'), JSON.stringify({ generate: { baseUrl: 'http://:p@h:1' } }));
    await assert.rejects(loadConfig(env), (e: unknown) => e instanceof UsageError &&
      e.message === 'Configurazione non valida: generate.baseUrl: generate.baseUrl deve essere un URL http o https senza credenziali');
  });
});

test('publicationUrl/globalUrl: toglie tutte le barre finali; messaggio senza pubblicazione', () => {
  const base = { generate: { provider: 'anthropic', model: 'm', maxTokens: 1, timeoutMs: 1000 } } as const;
  assert.equal(publicationUrl({ ...base, baseUrl: 'http://127.0.0.1:9///' }), 'http://127.0.0.1:9');
  assert.equal(publicationUrl({ ...base, baseUrl: 'http://127.0.0.1:9/a/', publication: 'foo' }), 'http://127.0.0.1:9/a');
  assert.equal(globalUrl({ ...base, baseUrl: 'http://127.0.0.1:9//' }), 'http://127.0.0.1:9');
  assert.equal(globalUrl({ ...base }), 'https://substack.com');
  assert.throws(() => publicationUrl({ ...base }), (e: unknown) => e instanceof UsageError &&
    e.message === 'Pubblicazione non configurata: esegui "substack config init --publication <subdomain>"');
});
