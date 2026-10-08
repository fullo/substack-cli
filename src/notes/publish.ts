import { markdownToDoc } from '../markdown/prosemirror.ts';
import type { PMDoc } from '../markdown/prosemirror.ts';
import { ApiShapeError, AuthError, RateLimitError, UsageError } from '../util/errors.ts';
import { withLock } from '../util/fs.ts';
import type { NoteStore } from './store.ts';

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

export async function publishOne(store: NoteStore, id: string, post: PostNote, now: Date): Promise<Outcome> {
  const note = await store.beginPublish(id);
  try {
    const result = await post(markdownToDoc(note.text));
    await store.completePublish(id, result.id, now);
    return { kind: 'published', substackId: result.id };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    switch (classifyPublishError(e)) {
      case 'revert':
        await store.revert(id, error.message);
        return { kind: 'reverted', error };
      case 'fail':
        await store.fail(id, error.message);
        return { kind: 'failed', error };
      default:
        await store.markUncertain(id, error.message);
        return { kind: 'uncertain', error };
    }
  }
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

export async function runDue(store: NoteStore, post: PostNote, now: Date): Promise<RunDueResult> {
  return withLock(store.lockPath, async () => {
    const result: RunDueResult = {
      published: [], reverted: [], failed: [], uncertain: [], stuck: [], corrupt: [], authFailed: false,
    };
    const { notes, corrupt } = await store.list();
    result.corrupt = corrupt;
    result.stuck = notes.filter((n) => n.status === 'publishing').map((n) => n.id);
    const due = notes
      .filter((n) => n.status === 'scheduled' && n.publishAt !== undefined && new Date(n.publishAt).getTime() <= now.getTime())
      .sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? ''));
    for (const n of due) {
      const out = await publishOne(store, n.id, post, now);
      if (out.kind === 'published') {
        result.published.push(n.id);
        continue;
      }
      const entry = { id: n.id, error: out.error.message };
      if (out.kind === 'failed') result.failed.push(entry);
      else if (out.kind === 'uncertain') result.uncertain.push(entry);
      else {
        result.reverted.push(entry);
        result.authFailed = out.error instanceof AuthError;
        break; // cookie scaduto o rate limit: inutile insistere con le altre
      }
    }
    return result;
  });
}
