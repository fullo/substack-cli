import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir } from '../config/config.ts';
import { AuthError, UsageError } from '../util/errors.ts';
import { atomicWriteFile, readTextIfExists } from '../util/fs.ts';
import { registerSecret } from '../util/redact.ts';

const SecretsSchema = z
  .object({
    sid: z.string().optional(),
    anthropicKey: z.string().optional(),
    llmKey: z.string().optional(),
  })
  .strict();

export type Secrets = z.infer<typeof SecretsSchema>;

const SID_RE = /^[A-Za-z0-9%._~+/=-]{16,2048}$/;

export function normalizeSid(input: string): string {
  const value = input.trim().replace(/^substack\.sid=/i, '').replace(/;$/, '').trim();
  if (!SID_RE.test(value)) {
    throw new UsageError(
      'Cookie non valido: copia solo il valore di "substack.sid" (nessuno spazio, punto e virgola o a capo). Vedi "substack auth guide".',
    );
  }
  return value;
}

export function secretsPath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), 'secrets.json');
}

async function readSecrets(env: NodeJS.ProcessEnv): Promise<Secrets> {
  const path = secretsPath(env);
  const text = await readTextIfExists(path);
  if (text === undefined) return {};
  try {
    return SecretsSchema.parse(JSON.parse(text));
  } catch {
    throw new UsageError(`File dei segreti non valido: ${path} (rimuovilo e ripeti "substack auth set")`);
  }
}

// Una variabile d'ambiente vuota o di soli spazi (es. chiave vuota in un Secret k8s) è come non impostata.
function fromEnv(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

export async function getSid(env: NodeJS.ProcessEnv): Promise<string> {
  const raw = fromEnv(env.SUBSTACK_SID) ?? (await readSecrets(env)).sid;
  if (!raw) {
    throw new AuthError('Cookie di sessione non configurato. Esegui "substack auth guide" per le istruzioni.');
  }
  const sid = normalizeSid(raw);
  registerSecret(sid);
  return sid;
}

export async function getApiKey(env: NodeJS.ProcessEnv, which: 'anthropic' | 'llm'): Promise<string | undefined> {
  const envKey = fromEnv(which === 'anthropic' ? env.ANTHROPIC_API_KEY : env.SUBSTACK_LLM_API_KEY);
  let key = envKey;
  if (key === undefined) {
    const secrets = await readSecrets(env);
    key = which === 'anthropic' ? secrets.anthropicKey : secrets.llmKey;
  }
  registerSecret(key);
  return key;
}

export async function saveSecret(env: NodeJS.ProcessEnv, patch: Secrets): Promise<void> {
  const next: Secrets = { ...(await readSecrets(env)), ...patch };
  if (next.sid !== undefined) next.sid = normalizeSid(next.sid);
  await atomicWriteFile(secretsPath(env), JSON.stringify(next, null, 2) + '\n', 0o600);
}

export async function secretsPermissionWarning(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  const st = await stat(secretsPath(env)).catch(() => undefined);
  if (st && (st.mode & 0o077) !== 0) {
    return `Il file ${secretsPath(env)} è leggibile da altri utenti: imposta i permessi a 0600 (chmod 600).`;
  }
  return undefined;
}
