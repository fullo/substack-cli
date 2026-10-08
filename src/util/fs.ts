import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

async function acquire(lockPath: string, staleMs: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (e) {
      if (errno(e) !== 'EEXIST') throw e;
      const st = await stat(lockPath).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > staleMs) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (!st) continue;
      throw new StateError(`Operazione già in corso (lock: ${lockPath})`);
    }
  }
  throw new StateError(`Impossibile acquisire il lock: ${lockPath}`);
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>, staleMs = 10 * 60_000): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  await acquire(lockPath, staleMs);
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}
