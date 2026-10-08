import { parseArticle } from '../markdown/frontmatter.ts';
import type { ParsedArticle } from '../markdown/frontmatter.ts';
import { markdownToDoc } from '../markdown/prosemirror.ts';
import { ProviderError } from '../util/errors.ts';
import type { Provider } from './provider.ts';

export class InvalidOutputError extends ProviderError {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.raw = raw;
  }
}

export interface GenerateOptions {
  topic: string;
  lang: string;
  maxTokens: number;
}

const ARTICLE_SYSTEM = `Sei un redattore di newsletter. Rispondi SOLO con un documento Markdown.
Il documento inizia con un front-matter YAML (--- title: ... subtitle: ... ---) seguito dal corpo.
Nel corpo usa solo: titoli ## e ###, paragrafi, **grassetto**, *corsivo*, liste, citazioni, link https, blocchi di codice.
Non usare HTML, tabelle, task list, immagini inline né testo fuori dal documento.`;

const NOTE_SYSTEM = `Scrivi una nota breve (massimo 600 caratteri) per un social di newsletter.
Rispondi SOLO con il testo della nota, in Markdown semplice (paragrafi, **grassetto**, *corsivo*, link https). Niente HTML.`;

export function extractMarkdown(raw: string): string {
  const text = raw.trim();
  const m = /^```(?:markdown|md)\n([\s\S]*?)\n```$/.exec(text);
  return m ? (m[1] ?? '').trim() : text;
}

export async function generateArticle(
  provider: Provider, opts: GenerateOptions,
): Promise<{ markdown: string; article: ParsedArticle }> {
  const raw = await provider.generate({
    system: ARTICLE_SYSTEM,
    prompt: `Scrivi un articolo in lingua "${opts.lang}" sul tema: ${opts.topic}`,
    maxTokens: opts.maxTokens,
  });
  const markdown = extractMarkdown(raw);
  try {
    return { markdown, article: parseArticle(markdown) };
  } catch (e) {
    throw new InvalidOutputError(`L'output generato non è un articolo valido: ${(e as Error).message}`, raw);
  }
}

export async function generateNote(provider: Provider, opts: GenerateOptions): Promise<string> {
  const raw = await provider.generate({
    system: NOTE_SYSTEM,
    prompt: `Scrivi una nota in lingua "${opts.lang}" sul tema: ${opts.topic}`,
    maxTokens: opts.maxTokens,
  });
  const text = extractMarkdown(raw);
  try {
    if (text.length > 5000) throw new Error('la nota supera i 5000 caratteri');
    markdownToDoc(text);
  } catch (e) {
    throw new InvalidOutputError(`L'output generato non è una nota valida: ${(e as Error).message}`, raw);
  }
  return text;
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'bozza';
}
