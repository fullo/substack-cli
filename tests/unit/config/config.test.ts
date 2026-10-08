import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir, dataDir, globalUrl, loadConfig, publicationUrl } from '../../../src/config/config.ts';
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

test('baseUrl di Substack: https oppure http solo su localhost', async () => {
  await withTmpDir(async (dir) => {
    const base = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'http://127.0.0.1:8080' })).baseUrl, 'http://127.0.0.1:8080');
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'http://localhost:1' })).baseUrl, 'http://localhost:1');
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'https://example.com' })).baseUrl, 'https://example.com');
    for (const bad of ['http://evil.example.com', 'ftp://x', 'javascript:alert(1)', 'non-un-url']) {
      await assert.rejects(loadConfig({ ...base, SUBSTACK_BASE_URL: bad }), UsageError, bad);
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
