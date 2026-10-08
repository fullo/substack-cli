import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubstackClient, parseDraftId } from '../../../src/substack/client.ts';
import { ApiShapeError, AuthError, NetworkError, RateLimitError, UsageError } from '../../../src/util/errors.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call, Route } from '../../helpers/fetch.ts';

const SID = 's%3AabcdefGHIJKLmnop1234567890.signature';
const PUB = 'https://pub.example';
const GLOBAL = 'https://glob.example';

function client(route: Route, calls: Call[] = [], sleeps: number[] = []) {
  return new SubstackClient({
    sid: SID,
    publicationUrl: PUB,
    globalUrl: GLOBAL,
    fetchImpl: makeFetch(route, calls),
    sleep: async (ms) => { sleeps.push(ms); },
  });
}
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

test('getProfile: cookie, user-agent, nessun redirect seguito, risposta validata', async () => {
  const calls: Call[] = [];
  const c = client(() => json({ id: 42, name: 'Ada', handle: 'ada', extra: 1 }), calls);
  const p = await c.getProfile();
  assert.equal(p.id, 42);
  assert.equal(calls[0]!.url, `${GLOBAL}/api/v1/user/profile/self`);
  assert.equal(header(calls[0]!, 'cookie'), `substack.sid=${SID}`);
  assert.match(header(calls[0]!, 'user-agent') ?? '', /substack-cli/);
  assert.equal(calls[0]!.init.redirect, 'manual');
  assert.ok(calls[0]!.init.signal);
});

test('401 e 403 → AuthError con rimando alla guida', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(client(() => json({}, status)).getProfile(), (e: Error) =>
      e instanceof AuthError && /auth guide/.test(e.message));
  }
});

test('risposta con forma errata → ApiShapeError che nomina endpoint e campo', async () => {
  await assert.rejects(client(() => json({ id: 'non-numero' })).getProfile(), (e: Error) =>
    e instanceof ApiShapeError && /user\/profile\/self/.test(e.message) && /id/.test(e.message));
  await assert.rejects(client(() => new Response('<html>', { status: 200 })).getProfile(), ApiShapeError);
});

test('stato inatteso 4xx → ApiShapeError con httpStatus', async () => {
  await assert.rejects(client(() => json({}, 404)).getProfile(), (e: Error) =>
    e instanceof ApiShapeError && (e as ApiShapeError).httpStatus === 404);
});

test('redirect non seguito → NetworkError', async () => {
  await assert.rejects(
    client(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })).getProfile(),
    NetworkError,
  );
});

test('GET idempotente: ritenta 503 con backoff e poi riesce', async () => {
  let n = 0;
  const sleeps: number[] = [];
  const c = client(() => (++n < 3 ? json({}, 503) : json({ id: 1 })), [], sleeps);
  assert.equal((await c.getProfile()).id, 1);
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('GET: dopo 3 tentativi falliti rilancia NetworkError', async () => {
  let n = 0;
  await assert.rejects(client(() => { n++; return json({}, 503); }).getProfile(), NetworkError);
  assert.equal(n, 3);
});

test('429 su GET: rispetta Retry-After (con tetto), poi ritenta', async () => {
  let n = 0;
  const sleeps: number[] = [];
  const c = client(() => (++n === 1 ? json({}, 429, { 'retry-after': '2' }) : json({ id: 1 })), [], sleeps);
  await c.getProfile();
  assert.deepEqual(sleeps, [2000]);

  let m = 0;
  const sleeps2: number[] = [];
  await client(() => (++m === 1 ? json({}, 429, { 'retry-after': '9999' }) : json({ id: 1 })), [], sleeps2).getProfile();
  assert.deepEqual(sleeps2, [30000]);
});

test('operazioni non idempotenti (createDraft, publish, postNote) non vengono mai ritentate', async () => {
  for (const status of [429, 503]) {
    let n = 0;
    const c = client(() => { n++; return json({}, status); });
    await assert.rejects(c.createDraft({ title: 't', body: { type: 'doc', content: [] }, authorId: 1 }),
      status === 429 ? RateLimitError : NetworkError);
    await assert.rejects(c.publishDraft(5, { sendEmail: false }));
    await assert.rejects(c.postNote({ type: 'doc', content: [] }));
    assert.equal(n, 3);
  }
});

test('errore di rete o timeout → NetworkError senza rivelare il cookie', async () => {
  const c = client(() => { throw new Error(`connessione rifiutata con substack.sid=${SID}`); });
  await assert.rejects(c.getProfile(), (e: Error) => e instanceof NetworkError && !e.message.includes(SID));
});

test('corpo di risposta troppo grande → ApiShapeError', async () => {
  const big = 'x'.repeat(5_000_001);
  await assert.rejects(client(() => new Response(big, { status: 200 })).getProfile(), ApiShapeError);
});

test('createDraft: percorso, corpo e URL di modifica', async () => {
  const calls: Call[] = [];
  const doc = { type: 'doc' as const, content: [{ type: 'paragraph' }] };
  const c = client(() => json({ id: 1001 }), calls);
  const r = await c.createDraft({ title: 'Titolo', subtitle: 'Sotto', body: doc, authorId: 42 });
  assert.deepEqual(r, { id: 1001, url: `${PUB}/publish/post/1001` });
  assert.equal(calls[0]!.url, `${PUB}/api/v1/drafts`);
  assert.equal(calls[0]!.init.method, 'POST');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.draft_title, 'Titolo');
  assert.equal(body.draft_subtitle, 'Sotto');
  assert.deepEqual(JSON.parse(body.draft_body), doc);
  assert.deepEqual(body.draft_bylines, [{ id: 42, is_guest: false }]);
  assert.equal(header(calls[0]!, 'content-type'), 'application/json');
});

test('listDrafts e getDraft', async () => {
  const calls: Call[] = [];
  const c = client((call) => call.url.includes('post_management')
    ? json({ posts: [{ id: 7, draft_title: 'A' }, { id: 8, draft_title: null }] })
    : json({ id: 7, draft_title: 'A' }), calls);
  assert.deepEqual((await c.listDrafts()).map((d) => d.id), [7, 8]);
  assert.match(calls[0]!.url, /^https:\/\/pub\.example\/api\/v1\/post_management\/drafts\?/);
  assert.equal((await c.getDraft(7)).draft_title, 'A');
  assert.equal(calls[1]!.url, `${PUB}/api/v1/drafts/7`);
});

test('publishDraft / scheduleDraft / cancelSchedule', async () => {
  const calls: Call[] = [];
  const c = client(() => json({}), calls);
  await c.publishDraft(5, { sendEmail: false });
  await c.publishDraft(5, { sendEmail: true });
  assert.equal(calls[0]!.url, `${PUB}/api/v1/drafts/5/publish`);
  assert.equal(JSON.parse(String(calls[0]!.init.body)).send, false);
  assert.equal(JSON.parse(String(calls[1]!.init.body)).send, true);

  await c.scheduleDraft(5, new Date('2026-10-09T07:00:00Z'), { sendEmail: false });
  assert.equal(calls[2]!.url, `${PUB}/api/v1/drafts/5/scheduled_release`);
  const sch = JSON.parse(String(calls[2]!.init.body));
  assert.equal(sch.trigger_at, '2026-10-09T07:00:00.000Z');
  assert.equal(sch.email_audience, 'no_one');
  await c.scheduleDraft(5, new Date('2026-10-09T07:00:00Z'), { sendEmail: true });
  assert.equal(JSON.parse(String(calls[3]!.init.body)).email_audience, 'everyone');

  await c.cancelSchedule(5);
  assert.equal(JSON.parse(String(calls[4]!.init.body)).trigger_at, null);
});

test('postNote: endpoint globale e id restituito come stringa', async () => {
  const calls: Call[] = [];
  const doc = { type: 'doc' as const, content: [{ type: 'paragraph' }] };
  const r = await client(() => json({ id: 123 }), calls).postNote(doc);
  assert.equal(r.id, '123');
  assert.equal(calls[0]!.url, `${GLOBAL}/api/v1/comment/feed`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)).bodyJson, doc);
});

test('parseDraftId accetta solo interi positivi (no path traversal)', () => {
  assert.equal(parseDraftId('123'), 123);
  for (const bad of [undefined, '', '0', '-1', '1.5', 'abc', '../x', '1/../2', '12345678901234567890', '1 ']) {
    assert.throws(() => parseDraftId(bad), UsageError, String(bad));
  }
});
