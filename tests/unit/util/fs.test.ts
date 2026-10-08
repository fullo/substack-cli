import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
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

test('withLock: presa di un lock stale da parte di più contendenti concorrenti → un solo vincitore', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    const old = new Date(Date.now() - 120_000);
    for (let iteration = 0; iteration < 40; iteration++) {
      await writeFile(lock, 'pid-morto');
      await utimes(lock, old, old);
      let inside = 0;
      let maxInside = 0;
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          withLock(lock, async () => {
            inside++;
            maxInside = Math.max(maxInside, inside);
            await new Promise((r) => setTimeout(r, 5));
            inside--;
            return 'ok';
          }, 60_000),
        ),
      );
      const winners = results.filter((r) => r.status === 'fulfilled').length;
      for (const r of results) {
        if (r.status === 'rejected') assert.ok(r.reason instanceof StateError, String(r.reason));
      }
      assert.equal(maxInside, 1, `iterazione ${iteration}: più detentori contemporanei`);
      assert.equal(winners, 1, `iterazione ${iteration}: ${winners} vincitori`);
      assert.deepEqual((await readdir(dir)).filter((f) => f !== '.lock'), [], 'nessun file temporaneo residuo');
      await rm(lock, { force: true });
    }
  });
});

test('withLock: chi ha perso il lock (scaduto e preso da altri) non cancella il lock del nuovo detentore', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    let releaseB!: () => void;
    let bAcquired!: () => void;
    const bHolding = new Promise<void>((r) => { bAcquired = r; });
    let pB!: Promise<string>;
    await withLock(lock, async () => {
      // A supera staleMs: il suo lock diventa "vecchio" e B lo prende.
      const old = new Date(Date.now() - 120_000);
      await utimes(lock, old, old);
      pB = withLock(lock, async () => {
        bAcquired();
        await new Promise<void>((r) => { releaseB = r; });
        return 'B';
      }, 60_000);
      await bHolding;
    }, 60_000);
    // A ha rilasciato: il lock di B deve essere ancora lì ed esclusivo.
    assert.ok(await readTextIfExists(lock), 'il lock di B è stato cancellato da A');
    await assert.rejects(withLock(lock, async () => 'C', 60_000), StateError);
    releaseB();
    assert.equal(await pB, 'B');
    assert.equal(await readTextIfExists(lock), undefined);
  });
});

test('withLock scrive nel file un token univoco del detentore', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) await withLock(lock, async () => { tokens.push((await readFile(lock, 'utf8')).trim()); });
    assert.match(tokens[0]!, new RegExp(`^${process.pid}\.[0-9a-f]{16,}$`));
    assert.notEqual(tokens[0], tokens[1]);
  });
});
