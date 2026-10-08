import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getApiKey, getSid, normalizeSid, saveSecret, secretsPermissionWarning } from '../../../src/auth/store.ts';
import { AuthError, UsageError } from '../../../src/util/errors.ts';
import { clearSecrets, redact } from '../../../src/util/redact.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const SID = 's%3AabcdefGHIJKLmnop1234567890.signature';

beforeEach(() => clearSecrets());

test('normalizeSid accetta il valore e il formato incollato "substack.sid=...;"', () => {
  assert.equal(normalizeSid(SID), SID);
  assert.equal(normalizeSid(`  substack.sid=${SID};  `), SID);
});

test('normalizeSid rifiuta valori che potrebbero iniettare header o sono troppo corti', () => {
  for (const bad of ['', 'corto', `${SID}; other=1`, `${SID}\r\nX-Evil: 1`, `${SID} spazio`, 'a'.repeat(5000)]) {
    assert.throws(() => normalizeSid(bad), UsageError, JSON.stringify(bad).slice(0, 30));
  }
});

test('getSid: env ha la precedenza sul file; senza nulla è AuthError', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    await assert.rejects(getSid(env), AuthError);
    await saveSecret(env, { sid: SID });
    assert.equal(await getSid(env), SID);
    const other = 's%3AaltroValoreDiCookie1234567890.sig';
    assert.equal(await getSid({ ...env, SUBSTACK_SID: other }), other);
  });
});

test('getSid registra il segreto per la redazione', async () => {
  await withTmpDir(async (dir) => {
    await getSid({ SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_SID: SID });
    assert.equal(redact(`errore con ${SID}`), 'errore con [REDACTED]');
  });
});

test('saveSecret unisce i campi, valida il cookie e usa permessi 0600', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    await saveSecret(env, { sid: SID });
    await saveSecret(env, { anthropicKey: 'sk-ant-test-key-1234' });
    const saved = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'));
    assert.deepEqual(saved, { sid: SID, anthropicKey: 'sk-ant-test-key-1234' });
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(dir, 'secrets.json'))).mode & 0o777, 0o600);
    }
    await assert.rejects(saveSecret(env, { sid: 'x; y' }), UsageError);
  });
});

test('getApiKey: env prima del file; anthropic e llm sono separate', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.equal(await getApiKey(env, 'anthropic'), undefined);
    await saveSecret(env, { anthropicKey: 'sk-ant-from-file-123', llmKey: 'llm-from-file-1234' });
    assert.equal(await getApiKey(env, 'anthropic'), 'sk-ant-from-file-123');
    assert.equal(await getApiKey({ ...env, ANTHROPIC_API_KEY: 'sk-ant-from-env-12345' }, 'anthropic'), 'sk-ant-from-env-12345');
    assert.equal(await getApiKey(env, 'llm'), 'llm-from-file-1234');
    assert.equal(await getApiKey({ ...env, SUBSTACK_LLM_API_KEY: 'llm-from-env-12345' }, 'llm'), 'llm-from-env-12345');
  });
});

test('file segreti corrotto o con chiavi sconosciute: errore chiaro', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'secrets.json'), '{ rotto');
    await assert.rejects(getSid(env), /secrets\.json/);
    await writeFile(join(dir, 'secrets.json'), JSON.stringify({ sidd: 'x' }));
    await assert.rejects(getSid(env), /secrets\.json/);
  });
});

test('secretsPermissionWarning segnala file leggibili da altri (solo POSIX)', { skip: process.platform === 'win32' }, async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.equal(await secretsPermissionWarning(env), undefined);
    await saveSecret(env, { sid: SID });
    assert.equal(await secretsPermissionWarning(env), undefined);
    const { chmod } = await import('node:fs/promises');
    await chmod(join(dir, 'secrets.json'), 0o644);
    assert.match((await secretsPermissionWarning(env)) ?? '', /0600/);
  });
});
