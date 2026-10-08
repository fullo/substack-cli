import { parse } from 'yaml';
import { z } from 'zod';
import { UsageError } from '../util/errors.ts';
import { formatIssues } from '../util/issues.ts';
import { isSafeSingleLine } from '../util/text.ts';
import { markdownToDoc } from './prosemirror.ts';
import type { PMDoc } from './prosemirror.ts';

// Il front-matter ammette solo title e subtitle: 8 KB bastano. Il parser YAML ha costi superlineari
// con molte chiavi (decine di secondi con 50k chiavi), quindi il limite va applicato prima di parse.
export const MAX_FRONT_MATTER_BYTES = 8192;

const SINGLE_LINE_MSG = 'deve stare su una riga, senza caratteri di controllo, di direzione o invisibili';

const FrontMatterSchema = z
  .object({
    title: z.string().min(1).max(300).refine(isSafeSingleLine, SINGLE_LINE_MSG),
    subtitle: z.string().max(500).refine(isSafeSingleLine, SINGLE_LINE_MSG).optional(),
  })
  .strict();

export type FrontMatter = z.infer<typeof FrontMatterSchema>;

export interface ParsedArticle {
  frontMatter: FrontMatter;
  doc: PMDoc;
}

export function parseArticle(source: string): ParsedArticle {
  // Un BOM UTF-8 iniziale (comune nei file salvati su Windows) non fa parte del contenuto.
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    throw new UsageError('Front-matter mancante: il file deve iniziare con "---" e contenere almeno "title"');
  }
  const end = text.indexOf('\n---', 4);
  const afterFence = end === -1 ? undefined : text.slice(end + 4);
  if (end === -1 || (afterFence !== '' && !afterFence?.startsWith('\n'))) {
    throw new UsageError('Front-matter non chiuso: manca la riga "---" di chiusura');
  }
  const yamlText = text.slice(4, end);
  if (Buffer.byteLength(yamlText, 'utf8') > MAX_FRONT_MATTER_BYTES) {
    throw new UsageError('Front-matter troppo grande (max 8 KB): ammessi solo title e subtitle');
  }
  let data: unknown;
  try {
    // logLevel 'error': gli avvisi della libreria andrebbero su stderr via process.emitWarning,
    // ripetendo il testo grezzo (non fidato, es. output di un LLM) fuori dal nostro filtro.
    data = parse(yamlText, { maxAliasCount: 0, schema: 'core', uniqueKeys: true, logLevel: 'error' });
  } catch (e) {
    throw new UsageError(`Front-matter YAML non valido: ${(e as Error).message}`);
  }
  const parsed = FrontMatterSchema.safeParse(data ?? {});
  if (!parsed.success) {
    throw new UsageError(`Front-matter non valido: ${formatIssues(parsed.error.issues)}`);
  }
  const body = (afterFence ?? '').replace(/^\n/, '');
  return { frontMatter: parsed.data, doc: markdownToDoc(body) };
}
