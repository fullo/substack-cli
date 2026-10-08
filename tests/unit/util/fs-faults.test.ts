// Iniezione di guasti e di corse deterministiche in src/util/fs.ts (nate dall'analisi dei mutanti
// sopravvissuti con Stryker). I rami "un altro processo ha rilasciato/ricreato il lock nel frattempo"
// non si possono provocare in modo affidabile con processi veri: qui si sostituiscono le funzioni di
// node:fs/promises (module.syncBuiltinESMExports aggiorna anche i binding ESM importati da fs.ts) e si
// simula esattamente la corsa voluta, delegando tutto il resto alle funzioni reali.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { atomicWriteFile, withLock } from '../../../src/util/fs.ts';
import { StateError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

type Fsp = typeof import('node:fs/promises');
const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises') as Fsp;
const real = {
  open: fsp.open, stat: fsp.stat, readFile: fsp.readFile, rename: fsp.rename, rm: fsp.rm,
  writeFile: fsp.writeFile, utimes: fsp.utimes,
};

function install(over: Partial<Record<keyof typeof real, unknown>>): void {
  Object.assign(fsp, over);
  syncBuiltinESMExports();
}

afterEach(() => {
  Object.assign(fsp, real);
  syncBuiltinESMExports();
  mock.timers.reset();
});

const errnoError = (code: string) => Object.assign(new Error(`${code}: finto`), { code });
const OLD = () => new Date(Date.now() - 120_000);

async function staleLock(lock: string, content = 'vecchio'): Promise<void> {
  await real.writeFile(lock, content);
  await real.utimes(lock, OLD(), OLD());
}

// Registra le chiamate a rm (percorso e opzioni) delegando a quella reale.
function spyRm(): { path: string; opts: unknown }[] {
  const calls: { path: string; opts: unknown }[] = [];
  install({ rm: async (path: string, opts?: Parameters<Fsp['rm']>[1]) => { calls.push({ path: String(path), opts }); return real.rm(path, opts); } });
  return calls;
}

// Conta le aperture del file di lock (createExclusive) delegando a open reale.
function spyOpen(target: string): { count: number } {
  const counter = { count: 0 };
  install({ open: (path: string, ...rest: unknown[]) => {
    if (String(path) === target) counter.count++;
    return (real.open as (...a: unknown[]) => unknown)(path, ...rest);
  } });
  return counter;
}

test('atomicWriteFile passa i permessi (default 0600) alla scrittura del temporaneo', async () => {
  await withTmpDir(async (dir) => {
    const modes: unknown[] = [];
    install({ writeFile: (path: string, data: string, opts: { mode?: number }) => { modes.push(opts?.mode); return real.writeFile(path, data, opts); } });
    await atomicWriteFile(join(dir, 'a'), 'x');
    await atomicWriteFile(join(dir, 'b'), 'x', 0o644);
    assert.deepEqual(modes, [0o600, 0o644]);
  });
});

test('atomicWriteFile: se la scrittura fallisce prima di creare il temporaneo, rilancia l\'errore originale', async () => {
  await withTmpDir(async (dir) => {
    install({ writeFile: async () => { throw errnoError('EACCES'); } });
    await assert.rejects(atomicWriteFile(join(dir, 'a'), 'x'), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EACCES');
  });
});

test('withLock: un errore di open diverso da EEXIST viene rilanciato', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    install({ open: async () => { throw errnoError('EACCES'); } });
    await assert.rejects(withLock(lock, async () => 1), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EACCES');
  });
});

test('withLock: il file di lock viene chiuso anche se la scrittura del token fallisce', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    let closed = 0;
    install({ open: async () => ({
      writeFile: async () => { throw errnoError('ENOSPC'); },
      close: async () => { closed++; },
    }) });
    await assert.rejects(withLock(lock, async () => 1), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOSPC');
    assert.equal(closed, 1);
  });
});

test('withLock: lock che sparisce a ogni tentativo (stat ENOENT) → 3 tentativi, poi messaggio esatto', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await real.writeFile(lock, 'di un altro');
    const opens = spyOpen(lock);
    install({ stat: async (path: string) => {
      if (String(path) === lock) throw errnoError('ENOENT');
      return real.stat(path);
    } });
    await assert.rejects(withLock(lock, async () => 1), (e: unknown) =>
      e instanceof StateError && e.message === `Impossibile acquisire il lock: ${lock}`);
    assert.equal(opens.count, 3);
  });
});

test('withLock: un errore di stat diverso da ENOENT viene rilanciato', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await real.writeFile(lock, 'di un altro');
    install({ stat: async (path: string) => {
      if (String(path) === lock) throw errnoError('EPERM');
      return real.stat(path);
    } });
    await assert.rejects(withLock(lock, async () => 1), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EPERM');
  });
});

test('withLock: un lock vecchio esattamente quanto staleMs non è ancora scaduto', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await real.writeFile(lock, 'di un altro');
    const NOW = 1_800_000_000_000;
    mock.timers.enable({ apis: ['Date'], now: NOW });
    install({ stat: async (path: string) => {
      const st = await real.stat(path);
      return String(path) === lock ? Object.assign(st, { mtimeMs: NOW - 60_000 }) : st;
    } });
    await assert.rejects(withLock(lock, async () => 1, 60_000), StateError);
    install({ stat: async (path: string) => {
      const st = await real.stat(path);
      return String(path) === lock ? Object.assign(st, { mtimeMs: NOW - 60_001 }) : st;
    } });
    assert.equal(await withLock(lock, async () => 'preso', 60_000), 'preso');
  });
});

test('presa in carico: marker scaduto ma già sparito → rimozione tollerante (force) e lock occupato', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    const marker = `${lock}.takeover`;
    await staleLock(lock);
    const rms = spyRm();
    // Il marker "esiste" (open fallisce con EEXIST) e risulta vecchio, ma sul disco non c'è più.
    install({
      open: async (path: string, ...rest: unknown[]) => {
        if (String(path) === marker) throw errnoError('EEXIST');
        return (real.open as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
      },
      stat: async (path: string) => {
        if (String(path) === marker) return { mtimeMs: Date.now() - 60_000 };
        return real.stat(path);
      },
    });
    await assert.rejects(withLock(lock, async () => 1, 60_000), (e: unknown) => e instanceof StateError && /già in corso/.test(e.message));
    assert.deepEqual(rms.filter((c) => c.path === marker).map((c) => c.opts), [{ force: true }]);
  });
});

test('presa in carico: il lock scaduto viene rilasciato dal detentore mentre lo si legge → si riprova e si acquisisce', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await staleLock(lock);
    let raced = false;
    install({ readFile: async (path: string, ...rest: unknown[]) => {
      if (String(path) === lock && !raced) {
        raced = true;
        await real.rm(lock);
        throw errnoError('ENOENT');
      }
      return (real.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    } });
    assert.equal(await withLock(lock, async () => 'ok', 60_000), 'ok');
    assert.equal(raced, true);
    await assert.rejects(real.stat(lock), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT');
  });
});

test('presa in carico: il lock viene rinfrescato dal detentore nel frattempo → non va rubato', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await staleLock(lock, 'vivo');
    const opens = spyOpen(lock);
    let statCalls = 0;
    install({ stat: async (path: string) => {
      if (String(path) === lock && ++statCalls === 2) {
        const now = new Date();
        await real.utimes(lock, now, now); // il detentore è vivo e ha aggiornato il lock
      }
      return real.stat(path);
    } });
    await assert.rejects(withLock(lock, async () => 1, 60_000), (e: unknown) => e instanceof StateError && /già in corso/.test(e.message));
    assert.equal(await real.readFile(lock, 'utf8'), 'vivo');
    assert.equal(opens.count, 1, 'dopo aver visto un lock vivo non si ritenta');
  });
});

test('presa in carico: rename ENOENT (lock rilasciato nel frattempo) → si riprova e si acquisisce', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await staleLock(lock);
    let raced = false;
    install({ rename: async (from: string, to: string) => {
      if (String(from) === lock && !raced) {
        raced = true;
        await real.rm(lock);
        throw errnoError('ENOENT');
      }
      return real.rename(from, to);
    } });
    assert.equal(await withLock(lock, async () => 'ok', 60_000), 'ok');
    assert.equal(raced, true);
  });
});

test('presa in carico: un errore di rename diverso da ENOENT viene rilanciato e il marker rimosso', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await staleLock(lock);
    install({ rename: async (from: string, to: string) => {
      if (String(from) === lock) throw errnoError('EBUSY');
      return real.rename(from, to);
    } });
    await assert.rejects(withLock(lock, async () => 1, 60_000), (e: unknown) => (e as NodeJS.ErrnoException).code === 'EBUSY');
    await assert.rejects(real.stat(`${lock}.takeover`), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT');
  });
});

test('presa in carico: il lock spostato non è quello osservato (ricreato da altri) → viene rimesso al suo posto', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await staleLock(lock, 'osservato');
    const opens = spyOpen(lock);
    const rms = spyRm();
    install({ rename: async (from: string, to: string) => {
      await real.rename(from, to);
      if (String(from) === lock) await real.writeFile(to, 'nuovo-detentore'); // ricreato tra lettura e rename
    } });
    await assert.rejects(withLock(lock, async () => 1, 60_000), (e: unknown) => e instanceof StateError && /già in corso/.test(e.message));
    assert.equal(await real.readFile(lock, 'utf8'), 'nuovo-detentore');
    assert.equal(opens.count, 1);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(dir), ['.lock']);
    for (const c of rms) assert.deepEqual(c.opts, { force: true }, c.path);
  });
});

test('ogni rimozione (temporanei, marker, lock scaduto, rilascio) è tollerante (force: true)', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await staleLock(lock);
    const rms = spyRm();
    assert.equal(await withLock(lock, async () => 'ok', 60_000), 'ok');
    const paths = rms.map((c) => c.path.slice(dir.length + 1).replace(/\.\d+\.[0-9a-f]+\.stale$/, '.<token>.stale'));
    assert.deepEqual(paths, ['.lock.<token>.stale', '.lock.takeover', '.lock']);
    for (const c of rms) assert.deepEqual(c.opts, { force: true }, c.path);
  });
});

test('rilascio: se il lock è già sparito al momento della rimozione non è un errore', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    let token = '';
    install({ readFile: async (path: string, ...rest: unknown[]) => {
      const v = await (real.readFile as (...a: unknown[]) => Promise<string>)(path, ...rest);
      if (String(path) === lock) { token = v; await real.rm(lock); } // sparisce tra lettura e rm
      return v;
    } });
    assert.equal(await withLock(lock, async () => 'ok'), 'ok');
    assert.ok(token.length > 0);
  });
});
