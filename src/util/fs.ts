import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { link, mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
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

// Lock tenuti da questo processo (percorso → token), per rilasciarli anche su SIGTERM/SIGINT.
const held = new Map<string, string>();

export interface LockHandle {
  /**
   * Heartbeat: verifica che il lock contenga ancora il nostro token e ne rinnova la data, così chi
   * lavora più di staleMs (es. run-due con molte note) non viene considerato morto. StateError se
   * il lock è sparito o è stato preso in carico da un altro processo: chi lo tiene deve fermarsi.
   */
  refresh(): Promise<void>;
}

export async function withLock<T>(
  lockPath: string, fn: (lock: LockHandle) => Promise<T>, staleMs = 10 * 60_000,
): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = await acquire(lockPath, staleMs);
  held.set(lockPath, token);
  const handle: LockHandle = {
    async refresh() {
      if ((await readTextIfExists(lockPath)) !== token) {
        throw new StateError(`Lock perso: ${lockPath} è stato rimosso o preso in carico da un altro processo`);
      }
      const now = new Date();
      await utimes(lockPath, now, now);
    },
  };
  try {
    return await fn(handle);
  } finally {
    held.delete(lockPath);
    await release(lockPath, token);
  }
}

/** Rilascio sincrono e best-effort dei lock di questo processo (solo se contengono ancora il nostro token). */
export function releaseHeldLocksSync(): void {
  for (const [path, token] of held) {
    try {
      if (readFileSync(path, 'utf8') === token) rmSync(path, { force: true });
    } catch {
      // già rimosso o illeggibile: niente da fare
    }
    held.delete(path);
  }
}

const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Su SIGTERM (es. activeDeadlineSeconds di k3s) e SIGINT rilascia i lock prima di uscire: altrimenti
 * il lock resterebbe fino alla sua scadenza e i run-due successivi fallirebbero.
 */
export function installLockCleanupOnSignals(
  proc: Pick<NodeJS.EventEmitter, 'once'> = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  for (const [signal, code] of Object.entries(SIGNAL_EXIT)) {
    proc.once(signal, () => {
      releaseHeldLocksSync();
      exit(code);
    });
  }
}
