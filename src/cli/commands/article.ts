import { stat } from 'node:fs/promises';
import { stringify } from 'yaml';
import { z } from 'zod';
import { parseArticle, parseSubtitle, parseTitle } from '../../markdown/frontmatter.ts';
import { docToMarkdown } from '../../markdown/export.ts';
import type { PMDoc } from '../../markdown/prosemirror.ts';
import { atomicWriteFile } from '../../util/fs.ts';
import { parseDraftId, parseEmailAudience } from '../../substack/client.ts';
import type { DraftPatch } from '../../substack/client.ts';
import { parseFutureInstant } from '../../util/clock.ts';
import { ApiShapeError, CliError, UsageError } from '../../util/errors.ts';
import { isImageUrl, parseImageUrl, readImageFile } from '../../util/image.ts';
import type { ImageFile } from '../../util/image.ts';
import type { SubstackClient } from '../../substack/client.ts';
import { t } from '../../util/i18n.ts';
import { isSafeSingleLine } from '../../util/text.ts';
import { emit, flag, makeClient, readSource, str } from '../shared.ts';
import type { Command } from '../shared.ts';
import type { Ctx } from '../context.ts';

/**
 * Conferma digitata nella lingua attiva: la parola da scrivere è quella mostrata nel prompt.
 * Una risposta diversa annulla senza toccare Substack.
 */
async function confirmByTyping(ctx: Ctx, word: string, cancelled: string): Promise<void> {
  const answer = await ctx.prompt(t(`Type "${word}" to confirm: `, `Scrivi "${word}" per confermare: `));
  if (answer.trim().toLowerCase() !== word) throw new UsageError(cancelled);
}

/** Copertina richiesta con --cover: un URL https già caricato oppure un file locale da caricare. */
type CoverSource = { kind: 'url'; url: string; label: string } | { kind: 'file'; img: ImageFile; label: string };

/** Valida --cover senza toccare la rete: URL https senza credenziali, oppure immagine locale leggibile e supportata. */
async function parseCover(value: string): Promise<CoverSource> {
  if (isImageUrl(value)) return { kind: 'url', url: parseImageUrl(value), label: value };
  return { kind: 'file', img: await readImageFile(value), label: value };
}

async function coverUrl(client: SubstackClient, cover: CoverSource): Promise<string> {
  return cover.kind === 'url' ? cover.url : (await client.uploadImage(cover.img)).url;
}

const DocSchema = z.object({ type: z.literal('doc'), content: z.array(z.any()) }).passthrough();

const PAGE_SIZES = [10, 25, 50, 100] as const;

function parsePageSize(value: string | undefined): number {
  if (value === undefined) return 25;
  const n = Number(value);
  if (!(PAGE_SIZES as readonly number[]).includes(n)) {
    throw new UsageError(t(`Invalid --limit: "${value}" (allowed: ${PAGE_SIZES.join(', ')})`, `--limit non valido: "${value}" (valori ammessi: ${PAGE_SIZES.join(', ')})`));
  }
  return n;
}

function parsePageNumber(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^[1-9][0-9]{0,5}$/.test(value)) {
    throw new UsageError(t(`Invalid --page: "${value}" (expected a positive integer)`, `--page non valido: "${value}" (atteso un intero positivo)`));
  }
  return Number(value);
}

function parseListStatus(value: string | undefined, searching: boolean): 'draft' | 'published' {
  if (value !== undefined && value !== 'draft' && value !== 'published') {
    throw new UsageError(t(`Invalid --status: "${value}" (allowed: draft, published)`, `--status non valido: "${value}" (valori ammessi: draft, published)`));
  }
  if (searching && value === 'draft') {
    throw new UsageError(t('--search only looks through published articles: remove --status draft', '--search cerca solo tra gli articoli pubblicati: togli --status draft'));
  }
  return value === 'published' || searching ? 'published' : 'draft';
}

function parseSearchQuery(value: string): string {
  const q = value.trim();
  if (q.length === 0 || q.length > 200 || !isSafeSingleLine(q)) {
    throw new UsageError(t('Invalid --search: expected 1-200 characters on one line', '--search non valido: attesi 1-200 caratteri su una riga'));
  }
  return q;
}

export const articleCommands: Command[] = [
  {
    path: 'article draft',
    summary: { en: 'Create an online draft from a Markdown file (or - for stdin)', it: 'Crea una bozza online da un file Markdown (o - per stdin)' },
    options: { 'dry-run': { type: 'boolean' }, cover: { type: 'string' } },
    async run(ctx, { values, positionals }) {
      const source = positionals[0];
      if (!source) throw new UsageError(t('Usage: substack article draft <file|-> [--cover <file|url>] [--dry-run]', 'Uso: substack article draft <file|-> [--cover <file|url>] [--dry-run]'));
      const { frontMatter, doc } = parseArticle(await readSource(ctx, source));
      const coverArg = str(values, 'cover');
      const cover = coverArg === undefined ? undefined : await parseCover(coverArg);
      if (flag(values, 'dry-run')) {
        emit(ctx, values,
          { dryRun: true, title: frontMatter.title, subtitle: frontMatter.subtitle ?? null, blocks: doc.content.length, cover: cover?.label ?? null },
          t(`[dry-run] Draft "${frontMatter.title}" (${doc.content.length} blocks${cover ? `, cover ${cover.label}` : ''}): no request sent`,
            `[dry-run] Bozza "${frontMatter.title}" (${doc.content.length} blocchi${cover ? `, copertina ${cover.label}` : ''}): nessuna richiesta inviata`));
        return 0;
      }
      const client = await makeClient(ctx);
      // L'immagine si carica prima di creare la bozza: se il caricamento fallisce non resta una bozza orfana.
      const coverImage = cover ? await coverUrl(client, cover) : undefined;
      const profile = await client.getProfile();
      const draft = await client.createDraft({
        title: frontMatter.title, subtitle: frontMatter.subtitle, body: doc, authorId: profile.id,
      });
      if (coverImage !== undefined) {
        try {
          await client.updateDraft(draft.id, { coverImage });
          const after = await client.getDraft(draft.id);
          if ((after.cover_image ?? '') !== coverImage) {
            throw new ApiShapeError(t('the draft does not show the cover after the update', 'la bozza non riporta la copertina dopo l\'aggiornamento'));
          }
        } catch (e) {
          // La bozza esiste già: il messaggio dà id, URL e il comando per ripetere solo la copertina,
          // mantenendo il codice d'uscita dell'errore originale (es. 2 cookie, 4 rete).
          const reason = e instanceof Error ? e.message : String(e);
          throw new CliError(
            t(`Draft created (id ${draft.id}, ${draft.url}) but the cover was not set: ${reason}. Retry with: substack article update ${draft.id} --cover ${coverImage}`,
              `Bozza creata (id ${draft.id}, ${draft.url}) ma copertina non impostata: ${reason}. Riprova con: substack article update ${draft.id} --cover ${coverImage}`),
            e instanceof CliError ? e.exitCode : 1, e instanceof CliError ? e.code : 'INTERNAL');
        }
      }
      emit(ctx, values, { id: draft.id, url: draft.url, coverImage: coverImage ?? null },
        t(`Draft created: id ${draft.id}\nEdit: ${draft.url}${coverImage ? `\nCover: ${coverImage}` : ''}`,
          `Bozza creata: id ${draft.id}\nModifica: ${draft.url}${coverImage ? `\nCopertina: ${coverImage}` : ''}`));
      return 0;
    },
  },
  {
    path: 'article list',
    summary: {
      en: 'List drafts (default) or published articles (--status published), paged with --limit 10|25|50|100 and --page; --search <text> searches published articles',
      it: 'Elenca le bozze (default) o gli articoli pubblicati (--status published), paginati con --limit 10|25|50|100 e --page; --search <testo> cerca tra i pubblicati',
    },
    options: { status: { type: 'string' }, limit: { type: 'string' }, page: { type: 'string' }, search: { type: 'string' } },
    async run(ctx, { values }) {
      const search = str(values, 'search');
      const status = parseListStatus(str(values, 'status'), search !== undefined);
      const limit = parsePageSize(str(values, 'limit'));
      const page = parsePageNumber(str(values, 'page'));
      const query = search === undefined ? undefined : parseSearchQuery(search);
      const offset = (page - 1) * limit;
      const client = await makeClient(ctx);
      // Una sola richiesta per chiamata: scorrere le pagine è una scelta esplicita di chi usa il comando.
      const items = query !== undefined ? await client.searchPosts(query, { limit, offset })
        : status === 'published' ? await client.listPublished({ limit, offset })
          : await client.listDrafts(limit, offset);
      const published = query !== undefined || status === 'published';
      const rows = items.slice(0, limit).map((d) => {
        const title = ('title' in d ? d.title : undefined) || d.draft_title || t('(untitled)', '(senza titolo)');
        return {
          id: d.id, title,
          link: client.postLink({ id: d.id, slug: d.slug, canonical_url: d.canonical_url, is_published: published ? true : false }),
          ...(published ? { date: d.post_date ?? null } : {}),
        };
      });
      const empty = query !== undefined ? t('No articles found.', 'Nessun articolo trovato.')
        : published ? t('No published articles.', 'Nessun articolo pubblicato.') : t('No drafts.', 'Nessuna bozza.');
      emit(ctx, values, rows, rows.length ? rows.map((r) => `${r.id}\t${r.title}\t${r.link}`).join('\n') : empty);
      if (!flag(values, 'json') && rows.length > 0) {
        const more = items.length >= limit ? t(` — next: --page ${page + 1}`, ` — successiva: --page ${page + 1}`) : '';
        ctx.err(t(`Page ${page}, ${rows.length} items${more}`, `Pagina ${page}, ${rows.length} elementi${more}`));
      }
      return 0;
    },
  },
  {
    path: 'article export',
    summary: {
      en: 'Download one article (draft or published) as Markdown with front matter: to stdout, or to --out <file> (--force overwrites)',
      it: 'Scarica un articolo (bozza o pubblicato) come Markdown con front-matter: su stdout, oppure in --out <file> (--force sovrascrive)',
    },
    options: { out: { type: 'string' }, force: { type: 'boolean' } },
    async run(ctx, { values, positionals }) {
      const id = parseDraftId(positionals[0]);
      const out = str(values, 'out');
      const client = await makeClient(ctx);
      // Una sola richiesta GET per articolo; non esiste (di proposito) un export di massa.
      const post = await client.getDraft(id);
      if (!post.draft_body) {
        throw new ApiShapeError(t(`Article ${id} has no body to export`, `L'articolo ${id} non ha un corpo da esportare`));
      }
      let doc;
      try { doc = DocSchema.parse(JSON.parse(post.draft_body)); } catch {
        throw new ApiShapeError(t(`Unexpected body format for article ${id} (Substack's API may have changed)`,
          `Formato del corpo inatteso per l'articolo ${id} (l'API di Substack potrebbe essere cambiata)`));
      }
      const { markdown, unsupported } = docToMarkdown(doc as PMDoc);
      const front = stringify({ title: post.draft_title ?? '', ...(post.draft_subtitle ? { subtitle: post.draft_subtitle } : {}) }, { lineWidth: 0 });
      const text = `---\n${front}---\n\n${markdown}\n`;
      if (unsupported.length > 0) {
        ctx.err(t(`Warning: elements without a Markdown form were replaced by a comment: ${unsupported.join(', ')}`,
          `Attenzione: elementi senza forma Markdown sostituiti da un commento: ${unsupported.join(', ')}`));
      }
      if (out === undefined) {
        emit(ctx, values, { id, title: post.draft_title ?? '', markdown: text, unsupported }, text.replace(/\n$/, ''));
        return 0;
      }
      if (!flag(values, 'force') && await stat(out).then(() => true, () => false)) {
        throw new UsageError(t(`File already exists: ${out} (use --force to overwrite)`, `Il file esiste già: ${out} (usa --force per sovrascrivere)`));
      }
      await atomicWriteFile(out, text, 0o644);
      emit(ctx, values, { id, file: out, unsupported }, t(`Article ${id} saved to ${out}`, `Articolo ${id} salvato in ${out}`));
      return 0;
    },
  },
  {
    path: 'article update',
    summary: {
      en: 'Update title (--title), subtitle (--subtitle) and/or body (--file <file|->) of an unpublished draft (needs confirmation or --yes)',
      it: 'Aggiorna titolo (--title), sottotitolo (--subtitle) e/o corpo (--file <file|->) di una bozza non pubblicata (richiede conferma o --yes)',
    },
    options: {
      title: { type: 'string' }, subtitle: { type: 'string' }, file: { type: 'string' }, cover: { type: 'string' },
      yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    },
    async run(ctx, { values, positionals }) {
      const id = parseDraftId(positionals[0]);
      const title = str(values, 'title');
      const subtitle = str(values, 'subtitle');
      const file = str(values, 'file');
      const coverArg = str(values, 'cover');
      if (title === undefined && subtitle === undefined && file === undefined && coverArg === undefined) {
        throw new UsageError(t('Usage: substack article update <id> [--title <text>] [--subtitle <text>] [--file <file|->] [--cover <file|url>] [--yes] [--dry-run]',
          'Uso: substack article update <id> [--title <testo>] [--subtitle <testo>] [--file <file|->] [--cover <file|url>] [--yes] [--dry-run]'));
      }
      let cover = coverArg === undefined ? undefined : await parseCover(coverArg);
      // Validazione completa prima di qualsiasi richiesta di rete.
      const patch: DraftPatch = {};
      let blocks: number | undefined;
      if (file !== undefined) {
        // Il file è la fonte completa: corpo, titolo e sottotitolo dal front-matter (come in "article draft").
        const { frontMatter, doc } = parseArticle(await readSource(ctx, file));
        patch.body = doc;
        patch.title = frontMatter.title;
        patch.subtitle = frontMatter.subtitle ?? '';
        blocks = doc.content.length;
      }
      // Le opzioni esplicite prevalgono sul front-matter.
      if (title !== undefined) patch.title = parseTitle(title);
      if (subtitle !== undefined) patch.subtitle = parseSubtitle(subtitle);
      const dry = flag(values, 'dry-run');
      // Sostituire il corpo cancella le modifiche fatte nell'editor web: stesso gating di "article publish".
      if (!dry && !flag(values, 'yes') && !ctx.isInteractive) {
        throw new UsageError(t('Non-interactive update: add --yes to confirm explicitly', 'Aggiornamento non interattivo: aggiungi --yes per confermare esplicitamente'));
      }

      const client = await makeClient(ctx);
      const draft = await client.getDraft(id);
      if (draft.is_published === true) {
        throw new UsageError(t(`Draft ${id} is already published: "article update" only edits unpublished drafts`,
          `La bozza ${id} risulta già pubblicata: "article update" modifica solo bozze non pubblicate`));
      }
      const oldTitle = draft.draft_title ?? '';
      const oldSubtitle = draft.draft_subtitle ?? '';
      if (patch.title === oldTitle) delete patch.title;
      if (patch.subtitle === oldSubtitle) delete patch.subtitle;
      const changes: string[] = [];
      if (patch.title !== undefined) changes.push(`${t('title', 'titolo')}: "${oldTitle}" → "${patch.title}"`);
      if (patch.subtitle !== undefined) changes.push(`${t('subtitle', 'sottotitolo')}: "${oldSubtitle}" → "${patch.subtitle}"`);
      if (patch.body !== undefined) changes.push(t(`body: replaced (${blocks} blocks)`, `corpo: sostituito (${blocks} blocchi)`));
      // Una copertina già uguale a quella richiesta non conta come modifica.
      if (cover?.kind === 'url' && (draft.cover_image ?? '') === cover.url) cover = undefined;
      if (cover !== undefined) {
        changes.push(cover.kind === 'file'
          ? t(`cover: set from file ${cover.label} (uploaded on confirmation)`, `copertina: impostata dal file ${cover.label} (caricato dopo la conferma)`)
          : t(`cover: set to ${cover.url}`, `copertina: impostata a ${cover.url}`));
      }
      // La chiave cover compare solo se --cover è stato usato: l'output JSON esistente resta invariato.
      const changed = { title: patch.title !== undefined, subtitle: patch.subtitle !== undefined, body: patch.body !== undefined,
        ...(coverArg !== undefined ? { cover: cover !== undefined } : {}) };

      if (changes.length === 0) {
        emit(ctx, values, { id, updated: false, changed },
          t(`No changes: draft ${id} already has these values`, `Nessuna modifica: la bozza ${id} ha già questi valori`));
        return 0;
      }
      const summary = [t(`Updating draft ${id}:`, `Aggiornamento della bozza ${id}:`), ...changes.map((c) => `  ${c}`)].join('\n');
      if (dry) {
        emit(ctx, values, { dryRun: true, id, changed, title: patch.title ?? oldTitle, subtitle: patch.subtitle ?? oldSubtitle },
          `[dry-run] ${summary}`);
        return 0;
      }
      const confirmInteractively = !flag(values, 'yes');
      if (confirmInteractively) {
        ctx.err(summary);
        await confirmByTyping(ctx, t('update', 'aggiorna'), t('Update cancelled', 'Aggiornamento annullato'));
      }
      // Il file della copertina si carica solo dopo la conferma: un annullamento non lascia immagini caricate.
      if (cover !== undefined) patch.coverImage = await coverUrl(client, cover);
      await client.updateDraft(id, patch);
      // L'endpoint di aggiornamento non è ancora confermato: si rilegge la bozza per verificare l'esito.
      const after = await client.getDraft(id);
      const missing: string[] = [];
      if (patch.coverImage !== undefined && (after.cover_image ?? '') !== patch.coverImage) missing.push(t('cover', 'copertina'));
      if (patch.title !== undefined && (after.draft_title ?? '') !== patch.title) missing.push(t('title', 'titolo'));
      if (patch.subtitle !== undefined && (after.draft_subtitle ?? '') !== patch.subtitle) missing.push(t('subtitle', 'sottotitolo'));
      if (missing.length > 0) {
        throw new ApiShapeError(
          t(`Substack accepted the request but draft ${id} does not look updated (${missing.join(', ')}): the API may have changed`,
            `Substack ha accettato la richiesta ma la bozza ${id} non risulta aggiornata (${missing.join(', ')}): l'API potrebbe essere cambiata`),
        );
      }
      emit(ctx, values, { id, updated: true, changed, title: after.draft_title ?? '', subtitle: after.draft_subtitle ?? '', ...(coverArg !== undefined ? { coverImage: after.cover_image ?? null } : {}) },
        // Con la conferma interattiva il riepilogo è già stato mostrato: non ripeterlo.
        confirmInteractively ? t(`Draft ${id} updated`, `Bozza ${id} aggiornata`) : `${summary}\n${t(`Draft ${id} updated`, `Bozza ${id} aggiornata`)}`);
      return 0;
    },
  },
  {
    path: 'article publish',
    summary: { en: 'Publish a draft (needs confirmation or --yes; email only with --send-email)', it: 'Pubblica una bozza (richiede conferma o --yes; email solo con --send-email)' },
    options: { yes: { type: 'boolean' }, 'send-email': { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    async run(ctx, { values, positionals }) {
      const id = parseDraftId(positionals[0]);
      const sendEmail = flag(values, 'send-email');
      const dry = flag(values, 'dry-run');
      if (!dry && !flag(values, 'yes') && !ctx.isInteractive) {
        throw new UsageError(t('Non-interactive publish: add --yes to confirm explicitly', 'Pubblicazione non interattiva: aggiungi --yes per confermare esplicitamente'));
      }
      const client = await makeClient(ctx);
      const draft = await client.getDraft(id);
      const title = draft.draft_title ?? t('(untitled)', '(senza titolo)');
      const summary = t(`Publishing "${title}" (id ${id}) — email to subscribers: ${sendEmail ? 'YES' : 'no'}`,
        `Pubblicazione di "${title}" (id ${id}) — email agli iscritti: ${sendEmail ? 'SÌ' : 'no'}`);
      if (dry) {
        emit(ctx, values, { dryRun: true, id, title, sendEmail }, `[dry-run] ${summary}`);
        return 0;
      }
      if (!flag(values, 'yes')) {
        ctx.err(summary);
        await confirmByTyping(ctx, t('publish', 'pubblica'), t('Publishing cancelled', 'Pubblicazione annullata'));
      }
      await client.publishDraft(id, { sendEmail });
      emit(ctx, values, { published: true, id, sendEmail }, t(`Published: "${title}" (id ${id})`, `Pubblicato: "${title}" (id ${id})`));
      return 0;
    },
  },
  {
    path: 'article schedule',
    summary: {
      en: 'Schedule (--at <ISO with offset>, --email <recipients, default everyone>, needs confirmation or --yes) or cancel (--cancel) Substack\'s own scheduled publishing',
      it: 'Schedula (--at <ISO con offset>, --email <destinatari, default everyone>, richiede conferma o --yes) o annulla (--cancel) la pubblicazione nativa di Substack',
    },
    options: {
      at: { type: 'string' }, cancel: { type: 'boolean' }, email: { type: 'string' },
      yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    },
    async run(ctx, { values, positionals }) {
      const id = parseDraftId(positionals[0]);
      const at = str(values, 'at');
      const cancel = flag(values, 'cancel');
      if ((at === undefined) === !cancel) throw new UsageError(t('Specify exactly one of --at <date> and --cancel', 'Specifica esattamente una opzione tra --at <data> e --cancel'));
      if (cancel && str(values, 'email') !== undefined) throw new UsageError(t('--email only applies to --at', '--email vale solo con --at'));
      if (cancel) {
        // Annullare non pubblica nulla: nessuna conferma richiesta.
        await (await makeClient(ctx)).cancelSchedule(id);
        emit(ctx, values, { id, cancelled: true }, t(`Schedule cancelled for draft ${id}`, `Schedulazione annullata per la bozza ${id}`));
        return 0;
      }
      const when = parseFutureInstant(at as string, ctx.now());
      // Substack non ha un valore "nessuna email": il default è inviarla a tutti gli iscritti,
      // e il destinatario compare sempre nel riepilogo prima della conferma.
      const emailAudience = parseEmailAudience(str(values, 'email'));
      const dry = flag(values, 'dry-run');
      // Una schedulazione è una pubblicazione differita: stesso gating di "article publish",
      // verificato prima di qualsiasi richiesta di rete.
      if (!dry && !flag(values, 'yes') && !ctx.isInteractive) {
        throw new UsageError(t('Non-interactive scheduling: add --yes to confirm explicitly', 'Schedulazione non interattiva: aggiungi --yes per confermare esplicitamente'));
      }
      const client = await makeClient(ctx);
      const title = (await client.getDraft(id)).draft_title ?? t('(untitled)', '(senza titolo)');
      const summary = t(`Scheduling "${title}" (id ${id}) for ${when.toISOString()} — email to: ${emailAudience}`,
        `Schedulazione di "${title}" (id ${id}) per ${when.toISOString()} — email a: ${emailAudience}`);
      if (dry) {
        emit(ctx, values, { dryRun: true, id, title, scheduledFor: when.toISOString(), emailAudience }, `[dry-run] ${summary}`);
        return 0;
      }
      if (!flag(values, 'yes')) {
        ctx.err(summary);
        await confirmByTyping(ctx, t('schedule', 'programma'), t('Scheduling cancelled', 'Schedulazione annullata'));
      }
      await client.scheduleDraft(id, when, { emailAudience });
      emit(ctx, values, { id, scheduledFor: when.toISOString(), emailAudience },
        t(`Draft ${id} scheduled for ${when.toISOString()} (email to: ${emailAudience})`,
          `Bozza ${id} schedulata per ${when.toISOString()} (email a: ${emailAudience})`));
      return 0;
    },
  },
];
