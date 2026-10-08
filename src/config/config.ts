import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readTextIfExists } from '../util/fs.ts';
import { UsageError } from '../util/errors.ts';

export function configDir(env: NodeJS.ProcessEnv): string {
  return env.SUBSTACK_CLI_CONFIG_DIR ?? join(homedir(), '.config', 'substack-cli');
}

export function dataDir(env: NodeJS.ProcessEnv): string {
  return env.SUBSTACK_CLI_DATA_DIR ?? join(homedir(), '.local', 'share', 'substack-cli');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

// Il cookie di sessione viene inviato a questo host: solo Substack (https) o loopback (http, test).
function isSafeSubstackBase(value: string): boolean {
  const url = parseUrl(value);
  if (!url || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'https:') return host === 'substack.com' || host.endsWith('.substack.com');
  return url.protocol === 'http:' && LOCAL_HOSTS.has(host);
}

// Endpoint LLM (llama.cpp/Ollama anche su host di rete locale): solo http/https, niente credenziali nell'URL.
function isSafeLlmBase(value: string): boolean {
  const url = parseUrl(value);
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
}

const ConfigSchema = z
  .object({
    publication: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'subdomain non valido').optional(),
    baseUrl: z
      .string()
      .refine(isSafeSubstackBase, 'baseUrl deve essere https://substack.com o https://*.substack.com (http solo su localhost), senza credenziali')
      .optional(),
    generate: z
      .object({
        provider: z.enum(['anthropic', 'openai-compat']).default('anthropic'),
        model: z.string().min(1).default('claude-sonnet-5-5'),
        baseUrl: z.string().refine(isSafeLlmBase, 'generate.baseUrl deve essere un URL http o https senza credenziali').optional(),
        maxTokens: z.number().int().min(1).max(64000).default(4096),
        timeoutMs: z.number().int().min(1000).max(600000).default(120000),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<Config> {
  const path = env.SUBSTACK_CLI_CONFIG ?? join(configDir(env), 'config.json');
  const text = await readTextIfExists(path);
  let raw: Record<string, unknown> = {};
  if (text !== undefined) {
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new UsageError(`config.json non è JSON valido (${path}): ${(e as Error).message}`);
    }
  }
  if (env.SUBSTACK_PUBLICATION) raw = { ...raw, publication: env.SUBSTACK_PUBLICATION };
  if (env.SUBSTACK_BASE_URL) raw = { ...raw, baseUrl: env.SUBSTACK_BASE_URL };
  return validateConfig(raw);
}

/** Valida un oggetto di configurazione (senza file né variabili d'ambiente). */
export function validateConfig(raw: unknown): Config {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`).join('; ');
    throw new UsageError(`Configurazione non valida: ${issues}`);
  }
  return parsed.data;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function publicationUrl(config: Config): string {
  if (config.baseUrl) return trimSlash(config.baseUrl);
  if (config.publication) return `https://${config.publication}.substack.com`;
  throw new UsageError('Pubblicazione non configurata: esegui "substack config init --publication <subdomain>"');
}

export function globalUrl(config: Config): string {
  return trimSlash(config.baseUrl ?? 'https://substack.com');
}
