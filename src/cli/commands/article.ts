import { parseArticle, parseSubtitle, parseTitle } from '../../markdown/frontmatter.ts';
import { parseDraftId } from '../../substack/client.ts';
import type { DraftPatch } from '../../substack/client.ts';
import { parseFutureInstant } from '../../util/clock.ts';
import { ApiShapeError, UsageError } from '../../util/errors.ts';
import { t } from '../../util/i18n.ts';
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

export const articleCommands: Command[] = [
  {
    path: 'article draft',
    summary: { en: 'Create an online draft from a Markdown file (or - for stdin)', it: 'Crea una bozza online da un file Markdown (o - per stdin)' },
    options: { 'dry-run': { type: 'boolean' } },
    async run(ctx, { values, positionals }) {
      const source = positionals[0];
      if (!source) throw new UsageError(t('Usage: substack article draft <file|-> [--dry-run]', 'Uso: substack article draft <file|-> [--dry-run]'));
      const { frontMatter, doc } = parseArticle(await readSource(ctx, source));
      if (flag(values, 'dry-run')) {
        emit(ctx, values,
          { dryRun: true, title: frontMatter.title, subtitle: frontMatter.subtitle ?? null, blocks: doc.content.length },
          t(`[dry-run] Draft "${frontMatter.title}" (${doc.content.length} blocks): no request sent`,
            `[dry-run] Bozza "${frontMatter.title}" (${doc.content.length} blocchi): nessuna richiesta inviata`));
        return 0;
      }
      const client = await makeClient(ctx);
      const profile = await client.getProfile();
      const draft = await client.createDraft({
        title: frontMatter.title, subtitle: frontMatter.subtitle, body: doc, authorId: profile.id,
      });
      emit(ctx, values, { id: draft.id, url: draft.url },
        t(`Draft created: id ${draft.id}\nEdit: ${draft.url}`, `Bozza creata: id ${draft.id}\nModifica: ${draft.url}`));
      return 0;
    },
  },
  {
    path: 'article list',
    summary: { en: 'List the most recent drafts', it: 'Elenca le bozze più recenti' },
    options: {},
    async run(ctx, { values }) {
      const drafts = await (await makeClient(ctx)).listDrafts();
      const rows = drafts.map((d) => ({ id: d.id, title: d.draft_title ?? t('(untitled)', '(senza titolo)') }));
      emit(ctx, values, rows, rows.length ? rows.map((r) => `${r.id}\t${r.title}`).join('\n') : t('No drafts.', 'Nessuna bozza.'));
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
      title: { type: 'string' }, subtitle: { type: 'string' }, file: { type: 'string' },
      yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    },
    async run(ctx, { values, positionals }) {
      const id = parseDraftId(positionals[0]);
      const title = str(values, 'title');
      const subtitle = str(values, 'subtitle');
      const file = str(values, 'file');
      if (title === undefined && subtitle === undefined && file === undefined) {
        throw new UsageError(t('Usage: substack article update <id> [--title <text>] [--subtitle <text>] [--file <file|->] [--yes] [--dry-run]',
          'Uso: substack article update <id> [--title <testo>] [--subtitle <testo>] [--file <file|->] [--yes] [--dry-run]'));
      }
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
      const changed = { title: patch.title !== undefined, subtitle: patch.subtitle !== undefined, body: patch.body !== undefined };

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
      await client.updateDraft(id, patch);
      // L'endpoint di aggiornamento non è ancora confermato: si rilegge la bozza per verificare l'esito.
      const after = await client.getDraft(id);
      const missing: string[] = [];
      if (patch.title !== undefined && (after.draft_title ?? '') !== patch.title) missing.push(t('title', 'titolo'));
      if (patch.subtitle !== undefined && (after.draft_subtitle ?? '') !== patch.subtitle) missing.push(t('subtitle', 'sottotitolo'));
      if (missing.length > 0) {
        throw new ApiShapeError(
          t(`Substack accepted the request but draft ${id} does not look updated (${missing.join(', ')}): the API may have changed`,
            `Substack ha accettato la richiesta ma la bozza ${id} non risulta aggiornata (${missing.join(', ')}): l'API potrebbe essere cambiata`),
        );
      }
      emit(ctx, values, { id, updated: true, changed, title: after.draft_title ?? '', subtitle: after.draft_subtitle ?? '' },
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
      en: 'Schedule (--at <ISO with offset>, needs confirmation or --yes) or cancel (--cancel) Substack\'s own scheduled publishing',
      it: 'Schedula (--at <ISO con offset>, richiede conferma o --yes) o annulla (--cancel) la pubblicazione nativa di Substack',
    },
    options: {
      at: { type: 'string' }, cancel: { type: 'boolean' }, 'send-email': { type: 'boolean' },
      yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    },
    async run(ctx, { values, positionals }) {
      const id = parseDraftId(positionals[0]);
      const at = str(values, 'at');
      const cancel = flag(values, 'cancel');
      if ((at === undefined) === !cancel) throw new UsageError(t('Specify exactly one of --at <date> and --cancel', 'Specifica esattamente una opzione tra --at <data> e --cancel'));
      if (cancel) {
        // Annullare non pubblica nulla: nessuna conferma richiesta.
        await (await makeClient(ctx)).cancelSchedule(id);
        emit(ctx, values, { id, cancelled: true }, t(`Schedule cancelled for draft ${id}`, `Schedulazione annullata per la bozza ${id}`));
        return 0;
      }
      const when = parseFutureInstant(at as string, ctx.now());
      const sendEmail = flag(values, 'send-email');
      const dry = flag(values, 'dry-run');
      // Una schedulazione è una pubblicazione differita: stesso gating di "article publish",
      // verificato prima di qualsiasi richiesta di rete.
      if (!dry && !flag(values, 'yes') && !ctx.isInteractive) {
        throw new UsageError(t('Non-interactive scheduling: add --yes to confirm explicitly', 'Schedulazione non interattiva: aggiungi --yes per confermare esplicitamente'));
      }
      const client = await makeClient(ctx);
      const title = (await client.getDraft(id)).draft_title ?? t('(untitled)', '(senza titolo)');
      const summary = t(`Scheduling "${title}" (id ${id}) for ${when.toISOString()} — email to subscribers: ${sendEmail ? 'YES' : 'no'}`,
        `Schedulazione di "${title}" (id ${id}) per ${when.toISOString()} — email agli iscritti: ${sendEmail ? 'SÌ' : 'no'}`);
      if (dry) {
        emit(ctx, values, { dryRun: true, id, title, scheduledFor: when.toISOString(), sendEmail }, `[dry-run] ${summary}`);
        return 0;
      }
      if (!flag(values, 'yes')) {
        ctx.err(summary);
        await confirmByTyping(ctx, t('schedule', 'programma'), t('Scheduling cancelled', 'Schedulazione annullata'));
      }
      await client.scheduleDraft(id, when, { sendEmail });
      emit(ctx, values, { id, scheduledFor: when.toISOString(), sendEmail },
        t(`Draft ${id} scheduled for ${when.toISOString()} (email: ${sendEmail ? 'yes' : 'no'})`,
          `Bozza ${id} schedulata per ${when.toISOString()} (email: ${sendEmail ? 'sì' : 'no'})`));
      return 0;
    },
  },
];
