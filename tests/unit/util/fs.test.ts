import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, readTextIfExists, withLock } from '../../../src/util/fs.ts';
import { StateError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

test('atomicWriteFile crea cartelle, scrive e sovrascrive senza lasciare temporanei', async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, 'a', 'b', 'x.json');
    await atomicWriteFile(file, 'uno');
    await atomicWriteFile(file, 'due');
    assert.equal(await readFile(file, 'utf8'), 'due');
    assert.deepEqual(await readdir(join(dir, 'a', 'b')), ['x.json']);
  });
});

test('atomicWriteFile usa permessi 0600', { skip: process.platform === 'win32' }, async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, 'secret.json');
    await atomicWriteFile(file, 'x');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });
});

test('readTextIfExists restituisce undefined se il file manca, rilancia altri errori', async () => {
  await withTmpDir(async (dir) => {
    assert.equal(await readTextIfExists(join(dir, 'nope')), undefined);
    await assert.rejects(readTextIfExists(dir)); // è una cartella: EISDIR
  });
});

test('withLock è esclusivo e si libera anche se fn lancia', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await withLock(lock, async () => {
      await assert.rejects(withLock(lock, async () => 1), StateError);
    });
    await assert.rejects(withLock(lock, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await withLock(lock, async () => 'ok'), 'ok');
  });
});

test('withLock recupera un lock vecchio (stale) ma non uno recente', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await writeFile(lock, '999999');
    await assert.rejects(withLock(lock, async () => 1, 60_000), StateError);
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    assert.equal(await withLock(lock, async () => 'recuperato', 60_000), 'recuperato');
  });
});
