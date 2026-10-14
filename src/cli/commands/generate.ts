import { join } from 'node:path';
import { getApiKey } from '../../auth/store.ts';
import { dataDir, loadConfig } from '../../config/config.ts';
import type { Config } from '../../config/config.ts';
import { anthropicProvider } from '../../generate/anthropic.ts';
import { generateArticle, generateNote, InvalidOutputError, slugify } from '../../generate/generate.ts';
import { openaiCompatProvider } from '../../generate/openai-compat.ts';
import type { Provider } from '../../generate/provider.ts';
import { UsageError, ProviderError } from '../../util/errors.ts';
import { getLang, t } from '../../util/i18n.ts';
import { atomicWriteFile } from '../../util/fs.ts';
import type { Ctx } from '../context.ts';
import { emit, flag, makeClient, str } from '../shared.ts';
import type { Command } from '../shared.ts';
import { storeFor } from './note.ts';

export async function buildProvider(ctx: Ctx, config: Config, override: string | undefined): Promise<Provider> {
  const kind = override ?? config.generate.provider;
  const { model, timeoutMs, baseUrl, anthropicBaseUrl } = config.generate;
  if (kind === 'anthropic') {
    const apiKey = await getApiKey(ctx.env, 'anthropic');
    if (!apiKey) throw new ProviderError(t('ANTHROPIC_API_KEY not configured (environment variable or secrets.json)', 'ANTHROPIC_API_KEY non configurata (variabile d\'ambiente o secrets.json)'));
    // Mai generate.baseUrl: è il server LLM locale/di rete e non deve ricevere la chiave Anthropic.
    // anthropicBaseUrl, se presente, è già validato come https://api.anthropic.com.
    return anthropicProvider({ apiKey, model, timeoutMs, baseUrl: anthropicBaseUrl, fetchImpl: ctx.fetchImpl });
  }
  if (kind === 'openai-compat') {
    if (!baseUrl) throw new UsageError(t('generate.baseUrl missing in config.json (e.g. http://localhost:8080 for llama.cpp)', 'generate.baseUrl mancante in config.json (es. http://localhost:8080 per llama.cpp)'));
    return openaiCompatProvider({ baseUrl, model, timeoutMs, apiKey: await getApiKey(ctx.env, 'llm'), fetchImpl: ctx.fetchImpl });
  }
  throw new UsageError(t(`Unknown provider: ${kind} (anthropic | openai-compat)`, `Provider sconosciuto: ${kind} (anthropic | openai-compat)`));
}

function topicOf(values: Record<string, unknown>): string {
  const topic = values.topic;
  if (typeof topic !== 'string' || topic.trim() === '') throw new UsageError(t('--topic "<subject>" is required', 'Serve --topic "<argomento>"'));
  return topic.trim();
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export const generateCommands: Command[] = [
  {
    path: 'generate article',
    summary: {
      en: 'Generate an article with an LLM and save it in drafts/ (with --draft also create the online draft)',
      it: 'Genera un articolo con un LLM e lo salva in drafts/ (con --draft crea anche la bozza online)',
    },
    options: { topic: { type: 'string' }, lang: { type: 'string' }, provider: { type: 'string' }, draft: { type: 'boolean' } },
    async run(ctx, { values }) {
      const config = await loadConfig(ctx.env);
      const provider = await buildProvider(ctx, config, str(values, 'provider'));
      const opts = { topic: topicOf(values), lang: str(values, 'lang') ?? getLang(), maxTokens: config.generate.maxTokens };
      const folder = join(dataDir(ctx.env), 'drafts');
      let result;
      try {
        result = await generateArticle(provider, opts);
      } catch (e) {
        if (e instanceof InvalidOutputError) {
          const rejected = join(folder, `${t('rejected', 'rifiutato')}-${stamp(ctx.now())}.md`);
          await atomicWriteFile(rejected, e.raw);
          throw new ProviderError(`${e.message}\n${t('Raw text saved to', 'Testo grezzo salvato in')} ${rejected}`);
        }
        throw e;
      }
      const file = join(folder, `${slugify(result.article.frontMatter.title)}-${stamp(ctx.now())}.md`);
      await atomicWriteFile(file, result.markdown + '\n');
      const out: Record<string, unknown> = { file, title: result.article.frontMatter.title };
      let human = t(`Article generated: ${file}`, `Articolo generato: ${file}`);
      if (flag(values, 'draft')) {
        const client = await makeClient(ctx);
        const profile = await client.getProfile();
        const draft = await client.createDraft({
          title: result.article.frontMatter.title, subtitle: result.article.frontMatter.subtitle,
          body: result.article.doc, authorId: profile.id,
        });
        out.draftId = draft.id;
        out.url = draft.url;
        human += t(`\nDraft created: id ${draft.id}\nEdit: ${draft.url}`, `\nBozza creata: id ${draft.id}\nModifica: ${draft.url}`);
      }
      emit(ctx, values, out, human);
      return 0;
    },
  },
  {
    path: 'generate note',
    summary: { en: 'Generate a note with an LLM and add it to the local queue (draft)', it: 'Genera una nota con un LLM e la aggiunge alla coda locale (draft)' },
    options: { topic: { type: 'string' }, lang: { type: 'string' }, provider: { type: 'string' } },
    async run(ctx, { values }) {
      const config = await loadConfig(ctx.env);
      const provider = await buildProvider(ctx, config, str(values, 'provider'));
      const text = await generateNote(provider, { topic: topicOf(values), lang: str(values, 'lang') ?? getLang(), maxTokens: config.generate.maxTokens });
      const store = storeFor(ctx);
      const note = await store.locked(() => store.add(text, ctx.now()));
      emit(ctx, values, note, t(`Note generated (draft): ${note.id}\n${text}`, `Nota generata (draft): ${note.id}\n${text}`));
      return 0;
    },
  },
];
