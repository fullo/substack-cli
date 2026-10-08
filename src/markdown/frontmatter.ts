import { parse } from 'yaml';
import { z } from 'zod';
import { UsageError } from '../util/errors.ts';
import { markdownToDoc } from './prosemirror.ts';
import type { PMDoc } from './prosemirror.ts';

const FrontMatterSchema = z
  .object({
    title: z.string().min(1).max(300),
    subtitle: z.string().max(500).optional(),
  })
  .strict();

export type FrontMatter = z.infer<typeof FrontMatterSchema>;

export interface ParsedArticle {
  frontMatter: FrontMatter;
  doc: PMDoc;
}

export function parseArticle(source: string): ParsedArticle {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    throw new UsageError('Front-matter mancante: il file deve iniziare con "---" e contenere almeno "title"');
  }
  const end = text.indexOf('\n---', 4);
  const afterFence = end === -1 ? undefined : text.slice(end + 4);
  if (end === -1 || (afterFence !== '' && !afterFence?.startsWith('\n'))) {
    throw new UsageError('Front-matter non chiuso: manca la riga "---" di chiusura');
  }
  const yamlText = text.slice(4, end);
  let data: unknown;
  try {
    data = parse(yamlText, { maxAliasCount: 0, schema: 'core', uniqueKeys: true });
  } catch (e) {
    throw new UsageError(`Front-matter YAML non valido: ${(e as Error).message}`);
  }
  const parsed = FrontMatterSchema.safeParse(data ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`)
      .join('; ');
    throw new UsageError(`Front-matter non valido: ${issues}`);
  }
  const body = (afterFence ?? '').replace(/^\n/, '');
  return { frontMatter: parsed.data, doc: markdownToDoc(body) };
}
