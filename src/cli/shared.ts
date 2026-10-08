import { readFile, stat } from 'node:fs/promises';
import { getSid } from '../auth/store.ts';
import { globalUrl, loadConfig, publicationUrl } from '../config/config.ts';
import { SubstackClient } from '../substack/client.ts';
import { UsageError } from '../util/errors.ts';
import type { Ctx } from './context.ts';

export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface Command {
  path: string;
  summary: string;
  options: Record<string, { type: 'boolean' | 'string' }>;
  run(ctx: Ctx, args: { values: Values; positionals: string[] }): Promise<number>;
}

export const MAX_INPUT_BYTES = 1_000_000;

export function str(values: Values, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
}

export function flag(values: Values, key: string): boolean {
  return values[key] === true;
}

export function emit(ctx: Ctx, values: Values, data: unknown, human: string): void {
  ctx.out(flag(values, 'json') ? JSON.stringify(data) : human);
}

export async function makeClient(ctx: Ctx): Promise<SubstackClient> {
  const config = await loadConfig(ctx.env);
  const sid = await getSid(ctx.env);
  return new SubstackClient({
    sid,
    publicationUrl: publicationUrl(config),
    globalUrl: globalUrl(config),
    fetchImpl: ctx.fetchImpl,
  });
}

export async function readSource(ctx: Ctx, source: string): Promise<string> {
  if (source === '-') return ctx.readStdin();
  const st = await stat(source).catch(() => undefined);
  if (!st || !st.isFile()) throw new UsageError(`File non trovato: ${source}`);
  if (st.size > MAX_INPUT_BYTES) throw new UsageError('File troppo grande (max 1 MB)');
  return readFile(source, 'utf8');
}
