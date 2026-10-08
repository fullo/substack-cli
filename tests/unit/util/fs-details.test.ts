// Test aggiuntivi dall'analisi dei mutanti (Stryker): pulizia dei temporanei in caso di errore,
// messaggi esatti, scadenza di default del lock e del marker di presa in carico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, readTextIfExists, withLock } from '../../../src/util/fs.ts';
import { StateError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const age = async (path: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  await utimes(path, t, t);
};

test('atomicWriteFile: se la rename fallisce rilancia e rimuove il temporaneo', async () => {
  await withTmpDir(async (dir) => {
    const target = join(dir, 'occupato');
    await mkdir(join(target, 'figlio'), { recursive: true }); // rename di un file su una cartella non vuota fallisce
    await assert.rejects(atomicWriteFile(target, 'x'), (e: unknown) => typeof (e as NodeJS.ErrnoException).code === 'string');
    assert.deepEqual(await readdir(dir), ['occupato']);
  });
});

test('atomicWriteFile: il nome temporaneo contiene pid e suffisso .tmp (visibile solo durante la scrittura)', async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, 'x.json');
    await atomicWriteFile(file, 'contenuto');
    assert.equal(await readFile(file, 'utf8'), 'contenuto');
    assert.equal(await readTextIfExists(file), 'contenuto');
  });
});

test('withLock: messaggio esatto quando il lock è occupato', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, 'sub', '.lock');
    await withLock(lock, async () => {
      await assert.rejects(withLock(lock, async () => 1), (e: unknown) =>
        e instanceof StateError && e.message === `Operazione già in corso (lock: ${lock})`);
    });
  });
});

test('withLock: scadenza di default 10 minuti', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await writeFile(lock, 'altro');
    await age(lock, 9 * 60_000);
    await assert.rejects(withLock(lock, async () => 1), StateError);
    await age(lock, 11 * 60_000);
    assert.equal(await withLock(lock, async () => 'preso'), 'preso');
    assert.deepEqual(await readdir(dir), []);
  });
});

test('withLock: un marker di presa in carico recente blocca, uno scaduto (> 30 s) viene rimosso', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    const marker = `${lock}.takeover`;
    await writeFile(lock, 'vecchio');
    await age(lock, 120_000);
    await writeFile(marker, 'altro-processo');
    await age(marker, 20_000);
    await assert.rejects(withLock(lock, async () => 1, 60_000), StateError);
    assert.equal(await readTextIfExists(marker), 'altro-processo', 'marker recente intatto');
    await age(marker, 40_000);
    await assert.rejects(withLock(lock, async () => 1, 60_000), StateError); // questo giro rimuove solo il marker
    assert.equal(await readTextIfExists(marker), undefined);
    assert.equal(await withLock(lock, async () => 'ok', 60_000), 'ok');
    assert.deepEqual(await readdir(dir), []);
  });
});

test('withLock: il rilascio non tocca un lock che non contiene più il proprio token', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await withLock(lock, async () => {
      await writeFile(lock, 'token-di-un-altro');
    });
    assert.equal(await readTextIfExists(lock), 'token-di-un-altro');
  });
});

test('withLock: il valore e l\'errore di fn passano invariati', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    const obj = { a: 1 };
    assert.equal(await withLock(lock, async () => obj), obj);
    const err = new Error('mio');
    await assert.rejects(withLock(lock, async () => { throw err; }), (e: unknown) => e === err);
    assert.equal(await readTextIfExists(lock), undefined);
  });
});

test('readTextIfExists: legge UTF-8', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, 'f'), 'è ok');
    assert.equal(await readTextIfExists(join(dir, 'f')), 'è ok');
  });
});
