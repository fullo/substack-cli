import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { startFakeSubstack, VALID_SID } from '../helpers/fake-substack.ts';

test('auth set da stdin salva il cookie (0600) e lo verifica; auth check ok', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url, { SUBSTACK_SID: '' });
  try {
    delete (sb.env as Record<string, string | undefined>).SUBSTACK_SID;
    const set = await sb.run(['auth', 'set'], { stdin: `substack.sid=${VALID_SID};\n` });
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /Sessione valida: Ada Test/);
    const saved = JSON.parse(await readFile(join(sb.configDir, 'secrets.json'), 'utf8'));
    assert.equal(saved.sid, VALID_SID);
    const check = await sb.run(['auth', 'check', '--json']);
    assert.equal(check.code, 0);
    assert.deepEqual(JSON.parse(check.stdout), { valid: true, id: 42, name: 'Ada Test', handle: 'ada' });
  } finally { await sb.cleanup(); await server.stop(); }
});

test('cookie scaduto/errato → exit 2 e il cookie non compare mai nell\'output', async () => {
  const server = await startFakeSubstack();
  const bad = 's%3AcookieSbagliato1234567890.xxx';
  const sb = await makeSandbox(server.url, { SUBSTACK_SID: bad });
  try {
    const r = await sb.run(['auth', 'check']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /auth guide/);
    assert.ok(!r.stdout.includes(bad) && !r.stderr.includes(bad));
  } finally { await sb.cleanup(); await server.stop(); }
});

test('cookie non configurato → exit 2; cookie malformato → exit 64', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    delete (sb.env as Record<string, string | undefined>).SUBSTACK_SID;
    assert.equal((await sb.run(['auth', 'check'])).code, 2);
    assert.equal((await sb.run(['auth', 'set'], { stdin: 'valore; con spazi' })).code, 64);
  } finally { await sb.cleanup(); await server.stop(); }
});
