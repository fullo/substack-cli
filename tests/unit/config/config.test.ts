import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir, dataDir, globalUrl, loadConfig, publicationUrl, validateConfig } from '../../../src/config/config.ts';
import { UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

test('senza file di config: default validi', async () => {
  await withTmpDir(async (dir) => {
    const cfg = await loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir });
    assert.equal(cfg.generate.provider, 'anthropic');
    assert.equal(cfg.generate.maxTokens, 4096);
    assert.equal(cfg.generate.timeoutMs, 120000);
    assert.equal(cfg.publication, undefined);
  });
});

test('percorsi: override via env, altrimenti sotto la home', () => {
  assert.equal(configDir({ SUBSTACK_CLI_CONFIG_DIR: '/c' }), '/c');
  assert.equal(dataDir({ SUBSTACK_CLI_DATA_DIR: '/d' }), '/d');
  assert.match(configDir({}), /substack-cli$/);
  assert.match(dataDir({}), /substack-cli$/);
});

test('legge config.json e applica gli override da env', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publication: 'miaposta' }));
    const cfg = await loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir });
    assert.equal(cfg.publication, 'miaposta');
    const cfg2 = await loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_PUBLICATION: 'altra' });
    assert.equal(cfg2.publication, 'altra');
  });
});

test('rifiuta chiavi sconosciute, subdomain non validi, JSON rotto', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publicaton: 'typo' }));
    await assert.rejects(loadConfig(env), UsageError);
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publication: 'Ev il.com/x' }));
    await assert.rejects(loadConfig(env), UsageError);
    await writeFile(join(dir, 'config.json'), '{ rotto');
    await assert.rejects(loadConfig(env), /JSON/);
  });
});

// Il cookie di sessione viene inviato a baseUrl: ammessi solo substack.com e i suoi sottodomini
// (https) e il loopback (http, per i test). In origine era accettato qualsiasi host https
// (es. https://example.com): ora è rifiutato, vedi errata del piano.
test('baseUrl di Substack: solo https su substack.com/*.substack.com, http solo su loopback', async () => {
  await withTmpDir(async (dir) => {
    const base = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'http://127.0.0.1:8080' })).baseUrl, 'http://127.0.0.1:8080');
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'http://localhost:1' })).baseUrl, 'http://localhost:1');
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'http://[::1]:9' })).baseUrl, 'http://[::1]:9');
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'https://substack.com' })).baseUrl, 'https://substack.com');
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'https://foo.substack.com' })).baseUrl, 'https://foo.substack.com');
    for (const bad of ['https://example.com', 'https://evil.example.com', 'https://user:pass@substack.com',
      'https://user@foo.substack.com', 'http://user:pass@localhost:1', 'https://substack.com.evil.com',
      'https://evilsubstack.com', 'http://substack.com', 'http://foo.substack.com',
      'http://evil.example.com', 'ftp://x', 'ftp://substack.com', 'javascript:alert(1)', 'non-un-url']) {
      await assert.rejects(loadConfig({ ...base, SUBSTACK_BASE_URL: bad }), UsageError, bad);
    }
  });
});

test('generate.baseUrl: solo http/https, senza credenziali nell URL (host LAN ammessi)', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    const withGen = (baseUrl: string) => writeFile(join(dir, 'config.json'), JSON.stringify({ generate: { baseUrl } }));
    for (const ok of ['http://10.0.0.5:8080/v1', 'https://llm.example.com/v1', 'http://localhost:11434', 'http://ollama.svc.cluster.local:11434']) {
      await withGen(ok);
      assert.equal((await loadConfig(env)).generate.baseUrl, ok);
    }
    for (const bad of ['file:///etc/passwd', 'ftp://llm.example.com', 'javascript:alert(1)', 'data:text/plain,x',
      'http://user:pass@10.0.0.5:8080', 'https://key@llm.example.com', 'non-un-url']) {
      await withGen(bad);
      await assert.rejects(loadConfig(env), UsageError, bad);
    }
  });
});

test('publicationUrl e globalUrl', () => {
  const base = { generate: { provider: 'anthropic', model: 'm', maxTokens: 1, timeoutMs: 1000 } } as const;
  assert.equal(publicationUrl({ ...base, publication: 'foo' }), 'https://foo.substack.com');
  assert.equal(globalUrl({ ...base, publication: 'foo' }), 'https://substack.com');
  assert.equal(publicationUrl({ ...base, baseUrl: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
  assert.equal(globalUrl({ ...base, baseUrl: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
  assert.throws(() => publicationUrl({ ...base }), UsageError);
});

test('validateConfig valida l\'oggetto in sé, senza file né variabili d\'ambiente', () => {
  assert.equal(validateConfig({ publication: 'buona' }).publication, 'buona');
  assert.equal(validateConfig({}).generate.provider, 'anthropic');
  assert.throws(() => validateConfig({ publication: 'evil.example/x' }), (e: Error) =>
    e instanceof UsageError && e.message === 'Configurazione non valida: publication: subdomain non valido');
  assert.throws(() => validateConfig({ publication: 'ok', generate: { baseUrl: 'file:///etc/passwd' } }), UsageError);
});
