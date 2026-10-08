import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoteStore } from '../../../src/notes/store.ts';
import { classifyPublishError, publishOne, runDue } from '../../../src/notes/publish.ts';
import { ApiShapeError, AuthError, NetworkError, RateLimitError, UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
import type { PMDoc } from '../../../src/markdown/prosemirror.ts';

const T0 = new Date('2026-10-08T10:00:00Z');
const DUE = new Date('2026-10-08T12:00:00Z');
const AFTER = new Date('2026-10-08T12:00:01Z');

async function scheduled(store: NoteStore, text: string, at = DUE) {
  const n = await store.add(text, T0);
  await store.schedule(n.id, at, T0);
  return n;
}

test('classifyPublishError', () => {
  assert.equal(classifyPublishError(new AuthError('x')), 'revert');
  assert.equal(classifyPublishError(new RateLimitError('x')), 'revert');
  assert.equal(classifyPublishError(new UsageError('x')), 'fail');
  assert.equal(classifyPublishError(new ApiShapeError('x', 400)), 'fail');
  assert.equal(classifyPublishError(new ApiShapeError('x', 499)), 'fail');
  assert.equal(classifyPublishError(new ApiShapeError('x', 200)), 'uncertain');
  assert.equal(classifyPublishError(new ApiShapeError('x')), 'uncertain');
  assert.equal(classifyPublishError(new NetworkError('x')), 'uncertain');
  assert.equal(classifyPublishError(new Error('boh')), 'uncertain');
});

test('runDue pubblica solo le note scadute, in ordine di publishAt', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const late = await scheduled(store, 'tardi', new Date('2026-10-08T11:00:00Z'));
    const early = await scheduled(store, 'presto', new Date('2026-10-08T10:30:00Z'));
    const future = await scheduled(store, 'futura', new Date('2026-10-09T10:00:00Z'));
    const draft = await store.add('bozza', T0);
    const posted: PMDoc[] = [];
    const r = await runDue(store, async (doc) => { posted.push(doc); return { id: `n${posted.length}` }; }, DUE);
    assert.deepEqual(r.published, [early.id, late.id]);
    assert.equal(posted.length, 2);
    assert.equal((await store.get(future.id)).status, 'scheduled');
    assert.equal((await store.get(draft.id)).status, 'draft');
    assert.equal((await store.get(early.id)).substackId, 'n1');
  });
});

test('runDue è idempotente: una seconda esecuzione non ripubblica', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'x');
    let calls = 0;
    const post = async () => { calls++; return { id: 'n' }; };
    await runDue(store, post, AFTER);
    const second = await runDue(store, post, AFTER);
    assert.equal(calls, 1);
    assert.deepEqual(second.published, []);
  });
});

test('AuthError: la nota torna schedulata, il ciclo si ferma e authFailed è true', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await scheduled(store, 'a', new Date('2026-10-08T10:30:00Z'));
    const b = await scheduled(store, 'b', new Date('2026-10-08T10:40:00Z'));
    let calls = 0;
    const r = await runDue(store, async () => { calls++; throw new AuthError('scaduto'); }, DUE);
    assert.equal(calls, 1);
    assert.equal(r.authFailed, true);
    assert.equal((await store.get(a.id)).status, 'scheduled');
    assert.match((await store.get(a.id)).error ?? '', /scaduto/);
    assert.equal((await store.get(b.id)).status, 'scheduled');
    assert.deepEqual(r.reverted.map((x) => x.id), [a.id]);
  });
});

test('errore di rete: la nota resta in publishing e non viene mai ripubblicata', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await scheduled(store, 'x');
    const r1 = await runDue(store, async () => { throw new NetworkError('timeout'); }, AFTER);
    assert.deepEqual(r1.uncertain.map((x) => x.id), [n.id]);
    assert.equal((await store.get(n.id)).status, 'publishing');
    let calls = 0;
    const r2 = await runDue(store, async () => { calls++; return { id: 'n' }; }, AFTER);
    assert.equal(calls, 0);
    assert.deepEqual(r2.stuck, [n.id]);
    assert.deepEqual(r2.published, []);
  });
});

test('rifiuto definitivo (400): la nota passa a failed e le altre proseguono', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const bad = await scheduled(store, 'rifiutata', new Date('2026-10-08T10:30:00Z'));
    const ok = await scheduled(store, 'ok', new Date('2026-10-08T10:40:00Z'));
    let n = 0;
    const r = await runDue(store, async () => {
      if (++n === 1) throw new ApiShapeError('400', 400);
      return { id: 'z' };
    }, DUE);
    assert.deepEqual(r.failed.map((x) => x.id), [bad.id]);
    assert.deepEqual(r.published, [ok.id]);
    assert.equal((await store.get(bad.id)).status, 'failed');
  });
});

test('rate limit: ripristina e interrompe', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'a', new Date('2026-10-08T10:30:00Z'));
    await scheduled(store, 'b', new Date('2026-10-08T10:40:00Z'));
    let calls = 0;
    const r = await runDue(store, async () => { calls++; throw new RateLimitError('429'); }, DUE);
    assert.equal(calls, 1);
    assert.equal(r.reverted.length, 1);
    assert.equal(r.authFailed, false);
  });
});

test('runDue segnala i file corrotti senza fermarsi', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'x');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${dir}/deadbeef0000.json`, 'rotto');
    const r = await runDue(store, async () => ({ id: 'n' }), AFTER);
    assert.equal(r.published.length, 1);
    assert.deepEqual(r.corrupt, ['deadbeef0000.json']);
  });
});

test('due runDue concorrenti: il secondo fallisce per il lock (StateError)', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'x');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Il secondo runDue parte solo quando il primo è dentro il lock (sta pubblicando): niente attese a
    // orologio, che sotto carico (es. mutation testing in parallelo) rendevano il test instabile.
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const first = runDue(store, async () => { entered(); await gate; return { id: 'n' }; }, AFTER);
    await inside;
    await assert.rejects(runDue(store, async () => ({ id: 'm' }), AFTER), /in corso/);
    release();
    assert.equal((await first).published.length, 1);
  });
});

test('publishOne su nota draft pubblica subito e restituisce l\'esito', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('ciao', T0);
    const out = await publishOne(store, n.id, async () => ({ id: 'abc' }), T0);
    assert.deepEqual(out, { kind: 'published', substackId: 'abc' });
    const n2 = await store.add('ciao2', T0);
    const bad = await publishOne(store, n2.id, async () => { throw new NetworkError('x'); }, T0);
    assert.equal(bad.kind, 'uncertain');
  });
});
