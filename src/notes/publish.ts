import { markdownToDoc } from '../markdown/prosemirror.ts';
import type { PMDoc } from '../markdown/prosemirror.ts';
import { ApiShapeError, AuthError, RateLimitError, StateError, UsageError } from '../util/errors.ts';
import { withLock } from '../util/fs.ts';
import type { Note, NoteStore } from './store.ts';

export type PostNote = (doc: PMDoc) => Promise<{ id: string }>;
export type ErrorClass = 'revert' | 'fail' | 'uncertain';

export function classifyPublishError(e: unknown): ErrorClass {
  if (e instanceof AuthError || e instanceof RateLimitError) return 'revert';
  if (e instanceof UsageError) return 'fail';
  if (e instanceof ApiShapeError && e.httpStatus !== undefined && e.httpStatus >= 400 && e.httpStatus < 500) return 'fail';
  return 'uncertain';
}

export type Outcome =
  | { kind: 'published'; substackId: string }
  | { kind: 'reverted' | 'failed' | 'uncertain'; error: Error };

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Pubblica una nota. `from`: stati da cui è ammessa ("note publish" accetta anche draft, run-due
 * solo scheduled). Lancia solo se la nota non può nemmeno entrare in "publishing" (nulla è stato
 * inviato); dopo l'invio ogni problema diventa un esito.
 */
export async function publishOne(
  store: NoteStore, id: string, post: PostNote, now: Date, from: ('draft' | 'scheduled')[] = ['draft', 'scheduled'],
): Promise<Outcome> {
  const note = await store.beginPublish(id, from);
  let result: { id: string };
  try {
    result = await post(markdownToDoc(note.text));
  } catch (e) {
    const error = asError(e);
    const kind = classifyPublishError(e);
    try {
      if (kind === 'revert') await store.revert(id, error.message);
      else if (kind === 'fail') await store.fail(id, error.message);
      else await store.markUncertain(id, error.message);
    } catch (recordErr) {
      return { kind: 'uncertain', error: new StateError(`${error.message}; stato locale non aggiornato: ${asError(recordErr).message}`) };
    }
    if (kind === 'revert') return { kind: 'reverted', error };
    if (kind === 'fail') return { kind: 'failed', error };
    return { kind: 'uncertain', error };
  }
  try {
    await store.completePublish(id, result.id, now);
  } catch (e) {
    // Pubblicata davvero: non va classificata come errore di invio (né riprovata).
    return {
      kind: 'uncertain',
      error: new StateError(`Nota pubblicata su Substack (id ${result.id}) ma stato locale non aggiornato: ${asError(e).message}`),
    };
  }
  return { kind: 'published', substackId: result.id };
}

export interface RunDueResult {
  published: string[];
  reverted: { id: string; error: string }[];
  failed: { id: string; error: string }[];
  uncertain: { id: string; error: string }[];
  stuck: string[];
  corrupt: string[];
  authFailed: boolean;
}

function isDue(n: Note, now: Date): boolean {
  return n.status === 'scheduled' && n.publishAt !== undefined && new Date(n.publishAt).getTime() <= now.getTime();
}

export async function runDue(
  store: NoteStore, post: PostNote, now: Date, opts: { staleMs?: number } = {},
): Promise<RunDueResult> {
  return withLock(store.lockPath, async (lock) => {
    const result: RunDueResult = {
      published: [], reverted: [], failed: [], uncertain: [], stuck: [], corrupt: [], authFailed: false,
    };
    const { notes, corrupt } = await store.list();
    result.corrupt = corrupt;
    result.stuck = notes.filter((n) => n.status === 'publishing').map((n) => n.id);
    const due = notes
      .filter((n) => isDue(n, now))
      .sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? ''));
    for (const n of due) {
      // Heartbeat: un giro lungo non deve sembrare morto; se il lock non è più nostro, fermati.
      try {
        await lock.refresh();
      } catch (e) {
        const done = result.published.length ? ` Già pubblicate: ${result.published.join(', ')}.` : '';
        throw new StateError(`${asError(e).message}: run-due interrotto.${done}`);
      }
      // Per ogni nota, un errore prima dell'invio (file sparito, corrotto, stato cambiato) non ferma
      // il giro: la nota viene annotata e si prosegue con le altre.
      let fresh: Note;
      try {
        fresh = await store.get(n.id);
      } catch (e) {
        if (e instanceof StateError) result.corrupt.push(`${n.id}.json`);
        else result.failed.push({ id: n.id, error: asError(e).message });
        continue;
      }
      // Rilettura sotto lock: la nota può essere stata tolta dalla coda o rimandata durante il giro.
      if (!isDue(fresh, now)) continue;
      let outcome: Outcome;
      try {
        outcome = await publishOne(store, n.id, post, now, ['scheduled']);
      } catch (e) {
        result.failed.push({ id: n.id, error: asError(e).message });
        continue;
      }
      if (outcome.kind === 'published') {
        result.published.push(n.id);
        continue;
      }
      const entry = { id: n.id, error: outcome.error.message };
      if (outcome.kind === 'failed') result.failed.push(entry);
      else if (outcome.kind === 'uncertain') result.uncertain.push(entry);
      else {
        result.reverted.push(entry);
        result.authFailed = outcome.error instanceof AuthError;
        break; // cookie scaduto o rate limit: inutile insistere con le altre
      }
    }
    return result;
  }, opts.staleMs);
}
