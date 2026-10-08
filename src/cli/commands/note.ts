import { join } from 'node:path';
import { dataDir, loadConfig } from '../../config/config.ts';
import { NoteStore } from '../../notes/store.ts';
import type { NoteStatus } from '../../notes/store.ts';
import { publishOne, runDue } from '../../notes/publish.ts';
import { parseFutureInstant } from '../../util/clock.ts';
import { StateError, UsageError } from '../../util/errors.ts';
import { withLock } from '../../util/fs.ts';
import type { Ctx } from '../context.ts';
import { emit, flag, makeClient, readSource, str } from '../shared.ts';
import type { Command } from '../shared.ts';

const STATUS_VALUES = ['draft', 'scheduled', 'publishing', 'published', 'failed'];

export function storeFor(ctx: Ctx): NoteStore {
  return new NoteStore(join(dataDir(ctx.env), 'notes'));
}

function requireId(positionals: string[]): string {
  const id = positionals[0];
  if (!id) throw new UsageError('Serve l\'id della nota');
  return id;
}

export const noteCommands: Command[] = [
  {
    path: 'note add',
    summary: 'Aggiunge una nota alla coda locale (testo, oppure - per stdin)',
    options: {},
    async run(ctx, { values, positionals }) {
      const arg = positionals[0];
      if (!arg) throw new UsageError('Uso: substack note add <testo|->');
      const text = arg === '-' ? (await readSource(ctx, '-')).trim() : arg;
      const note = await storeFor(ctx).add(text, ctx.now());
      emit(ctx, values, note, `Nota aggiunta (draft): ${note.id}`);
      return 0;
    },
  },
  {
    path: 'note list',
    summary: 'Elenca le note locali (--status draft|scheduled|publishing|published|failed)',
    options: { status: { type: 'string' } },
    async run(ctx, { values }) {
      const status = str(values, 'status');
      if (status !== undefined && !STATUS_VALUES.includes(status)) throw new UsageError(`Stato non valido: ${status}`);
      const { notes, corrupt } = await storeFor(ctx).list(status as NoteStatus | undefined);
      for (const f of corrupt) ctx.err(`Attenzione: file nota non leggibile: ${f}`);
      const human = notes.length
        ? notes.map((n) => `${n.id}\t${n.status}\t${n.publishAt ?? '-'}\t${n.text.replace(/\s+/g, ' ').slice(0, 60)}`).join('\n')
        : 'Nessuna nota.';
      emit(ctx, values, notes, human);
      return 0;
    },
  },
  {
    path: 'note schedule',
    summary: 'Schedula una nota (--at <ISO con offset>); la pubblica "notes run-due"',
    options: { at: { type: 'string' } },
    async run(ctx, { values, positionals }) {
      const at = str(values, 'at');
      if (!at) throw new UsageError('Uso: substack note schedule <id> --at <data ISO con offset>');
      const when = parseFutureInstant(at, ctx.now());
      const note = await storeFor(ctx).schedule(requireId(positionals), when, ctx.now());
      emit(ctx, values, note, `Nota ${note.id} schedulata per ${note.publishAt}`);
      return 0;
    },
  },
  {
    path: 'note unschedule',
    summary: 'Riporta una nota schedulata allo stato draft',
    options: {},
    async run(ctx, { values, positionals }) {
      const note = await storeFor(ctx).unschedule(requireId(positionals));
      emit(ctx, values, note, `Nota ${note.id} di nuovo in draft`);
      return 0;
    },
  },
  {
    path: 'note publish',
    summary: 'Pubblica subito una nota della coda',
    options: {},
    async run(ctx, { values, positionals }) {
      const id = requireId(positionals);
      const store = storeFor(ctx);
      const client = await makeClient(ctx);
      const outcome = await withLock(store.lockPath, () => publishOne(store, id, (doc) => client.postNote(doc), ctx.now()));
      if (outcome.kind === 'published') {
        emit(ctx, values, { id, substackId: outcome.substackId }, `Nota ${id} pubblicata (id Substack ${outcome.substackId})`);
        return 0;
      }
      if (outcome.kind === 'uncertain') {
        throw new StateError(`Esito incerto per la nota ${id} (${outcome.error.message}). Controlla su Substack e usa "note resolve ${id} --published|--retry".`);
      }
      throw outcome.error;
    },
  },
  {
    path: 'note resolve',
    summary: 'Risolve una nota rimasta in "publishing" (--published | --retry)',
    options: { published: { type: 'boolean' }, retry: { type: 'boolean' } },
    async run(ctx, { values, positionals }) {
      if (flag(values, 'published') === flag(values, 'retry')) throw new UsageError('Specifica esattamente una opzione tra --published e --retry');
      const store = storeFor(ctx);
      const how = flag(values, 'published') ? 'published' : 'retry';
      const note = await withLock(store.lockPath, () => store.resolve(requireId(positionals), how, ctx.now()));
      emit(ctx, values, note, `Nota ${note.id} → ${note.status}`);
      return 0;
    },
  },
  {
    path: 'notes run-due',
    summary: 'Pubblica le note schedulate scadute (per cron/systemd/k3s)',
    options: { 'dry-run': { type: 'boolean' } },
    async run(ctx, { values }) {
      const store = storeFor(ctx);
      if (flag(values, 'dry-run')) {
        const { notes } = await store.list('scheduled');
        const due = notes.filter((n) => n.publishAt !== undefined && new Date(n.publishAt).getTime() <= ctx.now().getTime());
        emit(ctx, values, { dryRun: true, due: due.map((n) => n.id) }, `[dry-run] Note da pubblicare: ${due.length}`);
        return 0;
      }
      await loadConfig(ctx.env); // fallisce subito se la config non è valida
      const client = await makeClient(ctx);
      const r = await runDue(store, (doc) => client.postNote(doc), ctx.now());
      emit(ctx, values, r, [
        `Pubblicate: ${r.published.length}`,
        ...r.reverted.map((x) => `Rimandata ${x.id}: ${x.error}`),
        ...r.failed.map((x) => `Fallita ${x.id}: ${x.error}`),
        ...r.uncertain.map((x) => `INCERTA ${x.id}: ${x.error}`),
        ...r.stuck.map((id) => `BLOCCATA ${id}: in "publishing", serve "note resolve"`),
        ...r.corrupt.map((f) => `File non leggibile: ${f}`),
      ].join('\n'));
      if (r.authFailed) return 2;
      if (r.stuck.length > 0 || r.uncertain.length > 0 || r.failed.length > 0 || r.corrupt.length > 0) return 6;
      return 0;
    },
  },
];
