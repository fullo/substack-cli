import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { installLockCleanupOnSignals, releaseHeldLocksSync, withLock } from '../../../src/util/fs.ts';
import { StateError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

test('refresh: rinnova la data del lock (staleMs minimo) e un concorrente non lo prende', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await withLock(lock, async (handle) => {
      const old = new Date(Date.now() - 1000);
      await utimes(lock, old, old); // già "scaduto" rispetto a staleMs = 50
      await handle.refresh();
      assert.ok(Date.now() - (await stat(lock)).mtimeMs < 50);
      await assert.rejects(withLock(lock, async () => 1, 5_000), /in corso/);
    }, 50);
  });
});

test('refresh: StateError se il lock non contiene più il nostro token (preso in carico) o è sparito', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await withLock(lock, async (handle) => {
      await writeFile(lock, 'altro');
      await assert.rejects(handle.refresh(), (e: unknown) => e instanceof StateError && /lock/i.test(e.message));
    }, 50);
    assert.equal(await readFile(lock, 'utf8'), 'altro');
  });
});

test('releaseHeldLocksSync: rimuove i lock tenuti da questo processo, non quelli altrui', async () => {
  await withTmpDir(async (dir) => {
    const mine = join(dir, 'a.lock');
    const theirs = join(dir, 'b.lock');
    await withLock(mine, async () => {
      await withLock(theirs, async () => {
        await writeFile(theirs, 'altro'); // nel frattempo preso da altri
        releaseHeldLocksSync();
        assert.equal(existsSync(mine), false);
        assert.equal(await readFile(theirs, 'utf8'), 'altro');
      });
    });
  });
});

test('installLockCleanupOnSignals: su SIGTERM/SIGINT rilascia i lock ed esce con 143/130', async () => {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
    await withTmpDir(async (dir) => {
      const lock = join(dir, '.lock');
      const proc = new EventEmitter();
      const exits: number[] = [];
      installLockCleanupOnSignals(proc, (c) => { exits.push(c); });
      await withLock(lock, async () => {
        proc.emit(signal);
        assert.equal(existsSync(lock), false);
      });
      assert.deepEqual(exits, [code]);
    });
  }
});
