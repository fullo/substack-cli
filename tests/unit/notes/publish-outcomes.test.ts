// Test aggiuntivi dall'analisi dei mutanti (Stryker): confini di classifyPublishError, esiti esatti di
// publishOne, scadenza "adesso" in runDue, risultati completi per ogni categoria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NoteStore } from '../../../src/notes/store.ts';
import { classifyPublishError, publishOne, runDue } from '../../../src/notes/publish.ts';
import { ApiShapeError, AuthError, NetworkError, RateLimitError, UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const T0 = new Date('2026-10-08T10:00:00Z');
const DUE = new Date('2026-10-08T12:00:00Z');

test('classifyPublishError: confini 4xx esatti', () => {
  assert.equal(classifyPublishError(new ApiShapeError('x', 399)), 'uncertain');
  assert.equal(classifyPublishError(new ApiShapeError('x', 400)), 'fail');
  assert.equal(classifyPublishError(new ApiShapeError('x', 499)), 'fail');
  assert.equal(classifyPublishError(new ApiShapeError('x', 500)), 'uncertain');
  assert.equal(classifyPublishError('stringa'), 'uncertain');
  assert.equal(classifyPublishError(undefined), 'uncertain');
});

test('publishOne: esiti completi per revert, fail e uncertain, con errore annotato', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await store.add('a', T0);
    const auth = new AuthError('scaduto');
    assert.deepEqual(await publishOne(store, a.id, async () => { throw auth; }, T0), { kind: 'reverted', error: auth });
    assert.equal((await store.get(a.id)).error, 'scaduto');
    assert.equal((await store.get(a.id)).status, 'draft');

    const b = await store.add('b', T0);
    const usage = new UsageError('rifiutata');
    assert.deepEqual(await publishOne(store, b.id, async () => { throw usage; }, T0), { kind: 'failed', error: usage });
    assert.deepEqual({ ...(await store.get(b.id)) }, { id: b.id, text: 'b', status: 'failed', createdAt: T0.toISOString(), error: 'rifiutata' });

    const c = await store.add('c', T0);
    const out = await publishOne(store, c.id, async () => { throw 'non un Error'; }, T0);
    assert.equal(out.kind, 'uncertain');
    assert.ok(out.kind !== 'published' && out.error instanceof Error && out.error.message === 'non un Error');
    assert.equal((await store.get(c.id)).error, 'non un Error');
    assert.equal((await store.get(c.id)).status, 'publishing');
  });
});

test('publishOne: invia il documento convertito e registra id e data di pubblicazione', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('Ciao **mondo**', T0);
    let sent: unknown;
    await publishOne(store, n.id, async (doc) => { sent = doc; return { id: 'z9' }; }, DUE);
    assert.deepEqual(sent, { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'Ciao ' }, { type: 'text', text: 'mondo', marks: [{ type: 'strong' }] }] }] });
    const saved = await store.get(n.id);
    assert.equal(saved.substackId, 'z9');
    assert.equal(saved.publishedAt, DUE.toISOString());
  });
});

test('runDue: una nota con publishAt esattamente uguale ad "adesso" è scaduta; un ms dopo no', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const now = await store.add('ora', T0);
    await store.schedule(now.id, DUE, T0);
    const later = await store.add('dopo', T0);
    await store.schedule(later.id, new Date(DUE.getTime() + 1), T0);
    const r = await runDue(store, async () => ({ id: 'n' }), DUE);
    assert.deepEqual(r, { published: [now.id], reverted: [], failed: [], uncertain: [], stuck: [], corrupt: [], authFailed: false });
  });
});

test('runDue: risultato completo con failed, uncertain, stuck e corrupt; l\'incertezza non ferma il ciclo', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const ids: string[] = [];
    for (const [i, m] of [[1, 10], [2, 20], [3, 30]] as const) {
      const n = await store.add(`n${i}`, T0);
      await store.schedule(n.id, new Date(Date.UTC(2026, 9, 8, 11, m)), T0);
      ids.push(n.id);
    }
    const stuck = await store.add('bloccata', T0);
    await store.beginPublish(stuck.id);
    await writeFile(join(dir, 'ffffffffffff.json'), 'rotto');
    let k = 0;
    const r = await runDue(store, async () => {
      k++;
      if (k === 1) throw new NetworkError('timeout');
      if (k === 2) throw new ApiShapeError('bad', 422);
      return { id: 'ok' };
    }, DUE);
    assert.deepEqual(r, {
      published: [ids[2]],
      reverted: [],
      failed: [{ id: ids[1], error: 'bad' }],
      uncertain: [{ id: ids[0], error: 'timeout' }],
      stuck: [stuck.id],
      corrupt: ['ffffffffffff.json'],
      authFailed: false,
    });
  });
});

test('runDue: RateLimitError → reverted con messaggio, authFailed false; AuthError → authFailed true', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', T0);
    await store.schedule(n.id, DUE, T0);
    const r = await runDue(store, async () => { throw new RateLimitError('troppe'); }, DUE);
    assert.deepEqual(r.reverted, [{ id: n.id, error: 'troppe' }]);
    assert.equal(r.authFailed, false);
    assert.deepEqual(r.published, []);
    const r2 = await runDue(store, async () => { throw new AuthError('cookie'); }, DUE);
    assert.deepEqual(r2.reverted, [{ id: n.id, error: 'cookie' }]);
    assert.equal(r2.authFailed, true);
  });
});

test('runDue: le note draft (senza publishAt) e quelle in altri stati non vengono pubblicate', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await store.add('bozza', T0);
    await writeFile(join(dir, 'aaaaaaaaaaaa.json'), JSON.stringify({
      id: 'aaaaaaaaaaaa', text: 'x', status: 'failed', createdAt: T0.toISOString(), publishAt: T0.toISOString() }));
    await writeFile(join(dir, 'bbbbbbbbbbbb.json'), JSON.stringify({
      id: 'bbbbbbbbbbbb', text: 'x', status: 'scheduled', createdAt: T0.toISOString() }));
    let calls = 0;
    const r = await runDue(store, async () => { calls++; return { id: 'n' }; }, DUE);
    assert.equal(calls, 0);
    assert.deepEqual(r.published, []);
  });
});
