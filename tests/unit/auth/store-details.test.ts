// Test aggiuntivi dall'analisi dei mutanti (Stryker): confini delle regex di cookie e chiavi, messaggi
// esatti, formato del file dei segreti, redazione delle chiavi lette.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getApiKey, getSid, normalizeApiKey, normalizeSid, saveSecret, secretsPath, secretsPermissionWarning,
} from '../../../src/auth/store.ts';
import { AuthError, UsageError } from '../../../src/util/errors.ts';
import { clearSecrets, redact } from '../../../src/util/redact.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

beforeEach(() => clearSecrets());

const SID_MSG = 'Cookie non valido: copia solo il valore di "substack.sid" (nessuno spazio, punto e virgola o a capo). Vedi "substack auth guide".';
const KEY_MSG = 'Chiave API non valida: deve essere di 8-512 caratteri ASCII stampabili, senza spazi né a capo.';

test('normalizeSid: confini 16..2048, alfabeto ammesso, prefisso case-insensitive', () => {
  assert.equal(normalizeSid('a'.repeat(16)), 'a'.repeat(16));
  assert.equal(normalizeSid('a'.repeat(2048)), 'a'.repeat(2048));
  assert.equal(normalizeSid('AZaz09%._~+/=-xxxx'), 'AZaz09%._~+/=-xxxx');
  assert.equal(normalizeSid('SUBSTACK.SID=' + 'b'.repeat(16)), 'b'.repeat(16));
  assert.equal(normalizeSid('substack.sid= ' + 'b'.repeat(16) + ' ;'), 'b'.repeat(16));
  // il prefisso si toglie solo all'inizio, il punto e virgola solo alla fine
  assert.equal(normalizeSid('xsubstack.sid=' + 'a'.repeat(16)), 'xsubstack.sid=' + 'a'.repeat(16));
  for (const bad of ['a'.repeat(15), 'a'.repeat(2049), 'a'.repeat(16) + '!', '!' + 'a'.repeat(16), 'a'.repeat(16) + ';;',
    'xsubstack.sid=' + 'a'.repeat(16) + ' x', 'a'.repeat(8) + ';' + 'b'.repeat(8)]) {
    assert.throws(() => normalizeSid(bad), (e: unknown) => e instanceof UsageError && e.message === SID_MSG, bad.slice(0, 20));
  }
});

test('normalizeApiKey: confini 8..512 e caratteri estremi ammessi (! e ~)', () => {
  assert.equal(normalizeApiKey('!'.repeat(8)), '!'.repeat(8));
  assert.equal(normalizeApiKey('~'.repeat(512)), '~'.repeat(512));
  for (const bad of ['a'.repeat(7), 'a'.repeat(513), ' '.repeat(10), 'a'.repeat(8) + '\x7F', 'x' + 'a'.repeat(8) + ' y']) {
    assert.throws(() => normalizeApiKey(bad), (e: unknown) => e instanceof UsageError && e.message === KEY_MSG);
  }
});

test('secretsPath sotto la cartella di configurazione', () => {
  assert.equal(secretsPath({ SUBSTACK_CLI_CONFIG_DIR: 'C:/cfg' }), join('C:/cfg', 'secrets.json'));
});

test('getSid: messaggio esatto se manca; normalizza il valore da env', async () => {
  await withTmpDir(async (dir) => {
    await assert.rejects(getSid({ SUBSTACK_CLI_CONFIG_DIR: dir }), (e: unknown) => e instanceof AuthError &&
      e.message === 'Cookie di sessione non configurato. Esegui "substack auth guide" per le istruzioni.');
    const sid = 'c'.repeat(20);
    assert.equal(await getSid({ SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_SID: ` substack.sid=${sid}; ` }), sid);
    await writeFile(join(dir, 'secrets.json'), JSON.stringify({ sid: '' }));
    await assert.rejects(getSid({ SUBSTACK_CLI_CONFIG_DIR: dir }), AuthError);
  });
});

test('file dei segreti non valido: messaggio esatto con percorso', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    await writeFile(secretsPath(env), JSON.stringify({ sid: 5 }));
    await assert.rejects(getApiKey(env, 'llm'), (e: unknown) => e instanceof UsageError &&
      e.message === `File dei segreti non valido: ${secretsPath(env)} (rimuovilo e ripeti "substack auth set")`);
  });
});

test('getApiKey: la chiave (normalizzata) viene registrata per la redazione', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.equal(await getApiKey({ ...env, SUBSTACK_LLM_API_KEY: '  llm-secret-12345 ' }, 'llm'), 'llm-secret-12345');
    assert.equal(redact('x llm-secret-12345 y'), 'x [REDACTED] y');
    await saveSecret(env, { anthropicKey: 'file-secret-abcdef' });
    assert.equal(await getApiKey(env, 'anthropic'), 'file-secret-abcdef');
    assert.equal(await getApiKey(env, 'llm'), undefined);
    assert.equal(redact('file-secret-abcdef'), '[REDACTED]');
  });
});

test('saveSecret: formato JSON indentato con a capo finale, valori normalizzati', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    const sid = 'd'.repeat(20);
    await saveSecret(env, { sid: `substack.sid=${sid};`, llmKey: '  llm-key-123456  ' });
    const raw = await readFile(secretsPath(env), 'utf8');
    assert.equal(raw, JSON.stringify({ sid, llmKey: 'llm-key-123456' }, null, 2) + '\n');
  });
});

test('secretsPermissionWarning: su Windows sempre undefined; su POSIX undefined se il file manca', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.equal(await secretsPermissionWarning(env), undefined);
    await saveSecret(env, { sid: 'e'.repeat(20) });
    if (process.platform === 'win32') {
      assert.equal(await secretsPermissionWarning(env), undefined);
    } else {
      const { chmod } = await import('node:fs/promises');
      for (const mode of [0o604, 0o640, 0o601, 0o610]) {
        await chmod(secretsPath(env), mode);
        assert.equal(await secretsPermissionWarning(env),
          `Il file ${secretsPath(env)} è leggibile da altri utenti: imposta i permessi a 0600 (chmod 600).`, mode.toString(8));
      }
      await chmod(secretsPath(env), 0o700);
      assert.equal(await secretsPermissionWarning(env), undefined);
    }
  });
});

test('secretsPermissionWarning (logica POSIX, simulata su qualsiasi piattaforma): bit di gruppo/altri → avviso', async () => {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const fsp = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const realStat = fsp.stat;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let mode: number | undefined = 0o600;
  Object.assign(fsp, { stat: async () => {
    if (mode === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { mode: 0o100000 | mode };
  } });
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  try {
    const env = { SUBSTACK_CLI_CONFIG_DIR: '/cfg' };
    const msg = `Il file ${secretsPath(env)} è leggibile da altri utenti: imposta i permessi a 0600 (chmod 600).`;
    for (const m of [0o600, 0o700, 0o400]) {
      mode = m;
      assert.equal(await secretsPermissionWarning(env), undefined, m.toString(8));
    }
    for (const m of [0o601, 0o602, 0o604, 0o610, 0o620, 0o640, 0o666, 0o777]) {
      mode = m;
      assert.equal(await secretsPermissionWarning(env), msg, m.toString(8));
    }
    mode = undefined;
    assert.equal(await secretsPermissionWarning(env), undefined);
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    mode = 0o666;
    assert.equal(await secretsPermissionWarning(env), undefined);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    Object.assign(fsp, { stat: realStat });
    syncBuiltinESMExports();
  }
});
