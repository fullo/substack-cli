import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StateError } from './errors.ts';

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

export async function atomicWriteFile(path: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, { mode });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (errno(e) === 'ENOENT') return undefined;
    throw e;
  }
}

function busy(lockPath: string): StateError {
  return new StateError(`Operazione già in corso (lock: ${lockPath})`);
}

function newToken(): string {
  return `${process.pid}.${randomBytes(12).toString('hex')}`;
}

// Crea il file solo se non esiste (O_EXCL) e ci scrive il contenuto. false se esiste già.
async function createExclusive(path: string, content: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (e) {
    if (errno(e) === 'EEXIST') return false;
    throw e;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return true;
}

async function isStale(path: string, staleMs: number): Promise<boolean | undefined> {
  const st = await stat(path).catch((e: unknown) => {
    if (errno(e) === 'ENOENT') return undefined;
    throw e;
  });
  return st === undefined ? undefined : Date.now() - st.mtimeMs > staleMs;
}

const TAKEOVER_STALE_MS = 30_000;

/**
 * Rimuove un lock scaduto. Le prese in carico sono serializzate da un secondo lock
 * (`<lock>.takeover`, creato con O_EXCL): così due contendenti non possono rimuovere uno il lock
 * appena creato dall'altro. Il lock scaduto viene spostato atomicamente (rename) su un nome
 * univoco e rimosso solo se è ancora quello osservato; altrimenti viene rimesso al suo posto.
 * Restituisce true se il lock scaduto è stato rimosso.
 */
async function removeStaleLock(lockPath: string, staleMs: number, token: string): Promise<boolean> {
  const takeoverPath = `${lockPath}.takeover`;
  if (!(await createExclusive(takeoverPath, token))) {
    // Un altro processo sta prendendo in carico il lock. Se è morto a metà, il suo marker scade.
    if ((await isStale(takeoverPath, TAKEOVER_STALE_MS)) === true) await rm(takeoverPath, { force: true });
    return false;
  }
  try {
    const observed = await readTextIfExists(lockPath);
    if (observed === undefined) return true;
    if ((await isStale(lockPath, staleMs)) !== true) return false;
    const grave = `${lockPath}.${token}.stale`;
    try {
      await rename(lockPath, grave);
    } catch (e) {
      if (errno(e) === 'ENOENT') return true;
      throw e;
    }
    const moved = await readTextIfExists(grave);
    if (moved !== observed) {
      // Nel frattempo il lock è stato rilasciato e ricreato da altri: rimettilo al suo posto.
      await link(grave, lockPath).catch(() => undefined);
      await rm(grave, { force: true });
      return false;
    }
    await rm(grave, { force: true });
    return true;
  } finally {
    await rm(takeoverPath, { force: true });
  }
}

async function acquire(lockPath: string, staleMs: number): Promise<string> {
  const token = newToken();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(lockPath, token)) return token;
    const stale = await isStale(lockPath, staleMs);
    if (stale === undefined) continue; // rilasciato nel frattempo: riprova
    if (!stale || !(await removeStaleLock(lockPath, staleMs, token))) throw busy(lockPath);
  }
  throw new StateError(`Impossibile acquisire il lock: ${lockPath}`);
}

// Rilascia il lock solo se è ancora nostro: se fn è durato oltre staleMs e un altro processo lo ha
// preso in carico, il file contiene il suo token e non va toccato.
async function release(lockPath: string, token: string): Promise<void> {
  if ((await readTextIfExists(lockPath)) === token) await rm(lockPath, { force: true });
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>, staleMs = 10 * 60_000): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = await acquire(lockPath, staleMs);
  try {
    return await fn();
  } finally {
    await release(lockPath, token);
  }
}
