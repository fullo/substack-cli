// Test aggiuntivi nati dall'analisi dei mutanti sopravvissuti (Stryker): fissano valori esatti
// (header, corpi, query string, messaggi, attese di backoff) e i confini dei controlli sugli stati HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubstackClient, parseDraftId } from '../../../src/substack/client.ts';
import { ApiShapeError, AuthError, NetworkError, RateLimitError, UsageError } from '../../../src/util/errors.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call, Route } from '../../helpers/fetch.ts';

const SID = 's%3AabcdefGHIJKLmnop1234567890.signature';
const PUB = 'https://pub.example';
const GLOBAL = 'https://glob.example';
const DOC = { type: 'doc' as const, content: [{ type: 'paragraph' }] };

function client(route: Route, calls: Call[] = [], sleeps: number[] = [], extra: Record<string, unknown> = {}) {
  return new SubstackClient({
    sid: SID,
    publicationUrl: PUB,
    globalUrl: GLOBAL,
    fetchImpl: makeFetch(route, calls),
    sleep: async (ms) => { sleeps.push(ms); },
    ...extra,
  });
}
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);
const body = (c: Call) => JSON.parse(String(c.init.body));

test('header esatti: user-agent, accept; GET senza content-type e senza corpo', async () => {
  const calls: Call[] = [];
  await client(() => json({ id: 1 }), calls).getProfile();
  assert.equal(header(calls[0]!, 'user-agent'), 'substack-cli/0.1 (+https://github.com/local/substack-cli)');
  assert.equal(header(calls[0]!, 'accept'), 'application/json');
  assert.equal(header(calls[0]!, 'content-type'), null);
  assert.equal(calls[0]!.init.body, undefined);
  assert.equal(calls[0]!.init.method, 'GET');
});

test('timeout: AbortSignal con il valore configurato (default 30 s)', async () => {
  const seen: number[] = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => { seen.push(ms); return original.call(AbortSignal, ms); };
  try {
    await client(() => json({ id: 1 })).getProfile();
    await client(() => json({ id: 1 }), [], [], { timeoutMs: 1234 }).getProfile();
  } finally {
    AbortSignal.timeout = original;
  }
  assert.deepEqual(seen, [30_000, 1234]);
});

test('maxAttempts configurabile e backoff esponenziale 500, 1000, 2000', async () => {
  let n = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    client(() => { n++; return json({}, 503); }, [], sleeps, { maxAttempts: 4 }).getProfile(),
    (e: Error) => e instanceof NetworkError && e.message === 'Errore del server (503) su /api/v1/user/profile/self',
  );
  assert.equal(n, 4);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
});

test('sleep di default: attende davvero (setTimeout) prima di ritentare', async (t) => {
  let n = 0;
  const c = new SubstackClient({
    sid: SID, publicationUrl: PUB, globalUrl: GLOBAL, maxAttempts: 2,
    fetchImpl: makeFetch(() => (++n === 1 ? json({}, 429, { 'retry-after': '2' }) : json({ id: 3 }))),
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = c.getProfile();
  for (let i = 0; i < 20; i++) await Promise.resolve(); // lascia arrivare la prima risposta
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(n, 1, 'il secondo tentativo non deve partire prima dei 2 s');
  t.mock.timers.tick(1999);
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(n, 1);
  t.mock.timers.tick(1);
  assert.equal((await pending).id, 3);
  assert.equal(n, 2);
});

test('sid vuoto: nessuna redazione spuria dei messaggi di errore', async () => {
  const c = new SubstackClient({
    sid: '', publicationUrl: PUB, globalUrl: GLOBAL, maxAttempts: 1,
    fetchImpl: makeFetch(() => { throw new Error('rete giù'); }),
  });
  await assert.rejects(c.getProfile(), (e: Error) => e.message === 'Richiesta a glob.example/api/v1/user/profile/self fallita: rete giù');
});

test('parseDraftId: messaggio esatto (anche per undefined)', () => {
  assert.throws(() => parseDraftId('abc'), (e: unknown) => e instanceof UsageError &&
    e.message === 'Id bozza non valido: "abc" (atteso un intero positivo)');
  assert.throws(() => parseDraftId(undefined), (e: unknown) => e instanceof UsageError &&
    e.message === 'Id bozza non valido: "" (atteso un intero positivo)');
  assert.equal(parseDraftId('999999999999999'), 999999999999999);
  assert.throws(() => parseDraftId('9999999999999999'), UsageError);
});

test('getDraft: metodo GET esplicito', async () => {
  const calls: Call[] = [];
  await client(() => json({ id: 7 }), calls).getDraft(7);
  assert.equal(calls[0]!.init.method, 'GET');
});

test('confini degli stati HTTP: 2xx ok; 300 e 399 redirect; 400/499 ApiShapeError; 500 rete; 199 inatteso', async () => {
  for (const status of [200, 201, 204, 299]) {
    const res = status === 204 ? new Response(null, { status }) : new Response(JSON.stringify({ id: 1 }), { status });
    if (status === 204) {
      await client(() => res).publishDraft(1, { sendEmail: false });
    } else {
      assert.equal((await client(() => res).getProfile()).id, 1, String(status));
    }
  }
  for (const status of [300, 301, 399]) {
    await assert.rejects(client(() => new Response(null, { status })).getProfile(), (e: Error) =>
      e instanceof NetworkError && e.message === `Redirect inatteso (${status}) su /api/v1/user/profile/self: non seguito per sicurezza`, String(status));
  }
  for (const status of [400, 402, 404, 499]) {
    await assert.rejects(client(() => json({}, status)).getProfile(), (e: Error) =>
      e instanceof ApiShapeError && e.httpStatus === status &&
      e.message === `Stato HTTP inatteso ${status} su /api/v1/user/profile/self`, String(status));
  }
  for (const status of [500, 502, 599]) {
    let n = 0;
    await assert.rejects(client(() => { n++; return json({}, status); }).getProfile(), (e: Error) =>
      e instanceof NetworkError && e.message === `Errore del server (${status}) su /api/v1/user/profile/self`);
    assert.equal(n, 3, String(status));
  }
});

test('stato 1xx/inferiore a 200 → ApiShapeError (fetch finto)', async () => {
  const fake = { status: 199, headers: new Headers(), text: async () => '{}' } as unknown as Response;
  await assert.rejects(client(() => fake).getProfile(), (e: Error) =>
    e instanceof ApiShapeError && e.httpStatus === 199 && e.message === 'Stato HTTP inatteso 199 su /api/v1/user/profile/self');
});

test('messaggi di AuthError e RateLimitError esatti', async () => {
  await assert.rejects(client(() => json({}, 401)).getProfile(), (e: Error) =>
    e instanceof AuthError &&
    e.message === 'Accesso negato (401) su /api/v1/user/profile/self: il cookie è scaduto o non valido. Esegui "substack auth guide".');
  await assert.rejects(client(() => json({}, 429), [], [], { maxAttempts: 1 }).getProfile(), (e: Error) =>
    e instanceof RateLimitError && e.message === 'Troppe richieste (429) su /api/v1/user/profile/self' &&
    e.retryAfterMs === undefined);
});

test('Retry-After: secondi, data HTTP, data passata (0), valore non valido (backoff)', async () => {
  const run = async (retryAfter: string) => {
    let n = 0;
    const sleeps: number[] = [];
    await client(() => (++n === 1 ? json({}, 429, { 'retry-after': retryAfter }) : json({ id: 1 })), [], sleeps).getProfile();
    return sleeps[0]!;
  };
  assert.equal(await run('0'), 0);
  assert.equal(await run('30'), 30_000);
  assert.equal(await run('31'), 30_000);
  const future = await run(new Date(Date.now() + 10_000).toUTCString());
  assert.ok(future > 5_000 && future <= 10_000, String(future));
  assert.equal(await run(new Date(Date.now() - 60_000).toUTCString()), 0);
  assert.equal(await run('non-una-data'), 500);
  assert.equal(await run('2s'), 500);
  assert.equal(await run('x2'), 500);
});

test('RateLimitError esposto con retryAfterMs dopo l\'ultimo tentativo', async () => {
  await assert.rejects(client(() => json({}, 429, { 'retry-after': '7' }), [], [], { maxAttempts: 1 }).getProfile(),
    (e: Error) => e instanceof RateLimitError && e.retryAfterMs === 7000);
});

test('errori non ritentabili (Auth, ApiShape) non vengono ritentati neanche su GET', async () => {
  for (const status of [401, 404]) {
    let n = 0;
    await assert.rejects(client(() => { n++; return json({}, status); }).getProfile());
    assert.equal(n, 1, String(status));
  }
  let m = 0;
  await assert.rejects(client(() => { m++; return json({ id: 'x' }); }).getProfile(), ApiShapeError);
  assert.equal(m, 1);
});

test('errore di rete: messaggio con host e percorso, cookie (anche decodificato) oscurato', async () => {
  const decoded = decodeURIComponent(SID);
  await assert.rejects(
    client(() => { throw new Error(`boom ${SID} e ${decoded}`); }, [], [], { maxAttempts: 1 }).getProfile(),
    (e: Error) => e instanceof NetworkError &&
      e.message === 'Richiesta a glob.example/api/v1/user/profile/self fallita: boom [REDACTED] e [REDACTED]',
  );
  await assert.rejects(
    client(() => { throw 'stringa'; }, [], [], { maxAttempts: 1 }).getProfile(), // eslint-disable-line no-throw-literal
    (e: Error) => e instanceof NetworkError && e.message.endsWith('fallita: stringa'),
  );
});

test('sid non decodificabile: viene comunque oscurato', async () => {
  const bad = 'abc%E0%A4%Aabcdefghijkl';
  const c = new SubstackClient({
    sid: bad, publicationUrl: PUB, globalUrl: GLOBAL, maxAttempts: 1,
    fetchImpl: makeFetch(() => { throw new Error(`x ${bad} y`); }),
  });
  await assert.rejects(c.getProfile(), (e: Error) => e.message.endsWith('fallita: x [REDACTED] y'));
});

test('dimensione della risposta: content-length dichiarato e corpo effettivo, al confine di 5 MB', async () => {
  const exact = JSON.stringify({ id: 1, pad: '' });
  const padded = JSON.stringify({ id: 1, pad: 'x'.repeat(5_000_000 - exact.length) });
  assert.equal(padded.length, 5_000_000);
  assert.equal((await client(() => new Response(padded, { status: 200 })).getProfile()).id, 1);
  await assert.rejects(client(() => new Response('{}', { status: 200, headers: { 'content-length': '5000001' } })).getProfile(),
    (e: Error) => e instanceof ApiShapeError && e.message === 'Risposta troppo grande su /api/v1/user/profile/self' &&
      (e as ApiShapeError).httpStatus === 200);
  const fake = (len: string, text: string) =>
    ({ status: 200, headers: new Headers({ 'content-length': len }), text: async () => text }) as unknown as Response;
  assert.equal((await client(() => fake('5000000', '{"id":2}')).getProfile()).id, 2);
  await assert.rejects(client(() => fake('10', 'x'.repeat(5_000_001))).getProfile(),
    (e: Error) => e instanceof ApiShapeError && /troppo grande/.test(e.message));
});

test('corpo vuoto → null validato dallo schema; JSON non valido → messaggio esatto', async () => {
  await client(() => new Response('', { status: 200 })).publishDraft(1, { sendEmail: false });
  await assert.rejects(client(() => new Response('', { status: 200 })).getProfile(), (e: Error) =>
    e instanceof ApiShapeError && /\(radice\)/.test(e.message));
  await assert.rejects(client(() => new Response('{rotto', { status: 201 })).getProfile(), (e: Error) =>
    e instanceof ApiShapeError && e.message === 'Risposta non JSON su /api/v1/user/profile/self' && (e as ApiShapeError).httpStatus === 201);
});

test('forma errata: messaggio con percorso del campo e status', async () => {
  await assert.rejects(client(() => json({ posts: [{ id: 'x' }] })).listDrafts(), (e: Error) =>
    e instanceof ApiShapeError && (e as ApiShapeError).httpStatus === 200 &&
    e.message.startsWith("Risposta inattesa su /api/v1/post_management/drafts?offset=0&limit=25&order_by=draft_updated_at&order_direction=desc (l'API di Substack potrebbe essere cambiata): posts.0.id: "));
  await assert.rejects(client(() => json({ id: 1 })).listDrafts(), (e: Error) => /\(l'API di Substack potrebbe essere cambiata\): posts: \S/.test(e.message));
  await assert.rejects(client(() => json({ a: 1 })).getProfile(), (e: Error) => /\(l'API di Substack potrebbe essere cambiata\): id: \S/.test(e.message));
  await assert.rejects(client(() => json({ id: 1, name: 2, handle: 3 })).getProfile(), (e: Error) =>
    /name: .*; handle: /.test(e.message));
});

test('createDraft: corpo completo con subtitle vuoto di default; nessun retry', async () => {
  const calls: Call[] = [];
  await client(() => json({ id: 5 }), calls).createDraft({ title: 'T', body: DOC, authorId: 9 });
  assert.deepEqual(body(calls[0]!), {
    draft_title: 'T',
    draft_subtitle: '',
    draft_body: JSON.stringify(DOC),
    type: 'newsletter',
    audience: 'everyone',
    draft_bylines: [{ id: 9, is_guest: false }],
  });
  assert.equal(header(calls[0]!, 'accept'), 'application/json');
  await assert.rejects(client(() => json({ id: 0 })).createDraft({ title: 'T', body: DOC, authorId: 9 }), ApiShapeError);
});

test('listDrafts: query string esatta e limite personalizzato', async () => {
  const calls: Call[] = [];
  const c = client(() => json({ posts: [] }), calls);
  await c.listDrafts();
  await c.listDrafts(5);
  assert.equal(calls[0]!.url, `${PUB}/api/v1/post_management/drafts?offset=0&limit=25&order_by=draft_updated_at&order_direction=desc`);
  assert.equal(calls[1]!.url, `${PUB}/api/v1/post_management/drafts?offset=0&limit=5&order_by=draft_updated_at&order_direction=desc`);
  assert.equal(calls[0]!.init.method, 'GET');
});

test('getDraft e listDrafts sono idempotenti: ritentati su 503', async () => {
  let n = 0;
  const c = client(() => (++n % 2 === 1 ? json({}, 503) : json({ id: 7, posts: [] })));
  assert.equal((await c.getDraft(7)).id, 7);
  assert.deepEqual(await c.listDrafts(), []);
  assert.equal(n, 4);
});

test('publish/schedule/cancel: metodo, corpi completi, retry solo su cancelSchedule', async () => {
  const calls: Call[] = [];
  const c = client(() => json({}), calls);
  await c.publishDraft(5, { sendEmail: true });
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(header(calls[0]!, 'content-type'), 'application/json');
  assert.deepEqual(body(calls[0]!), { send: true, share_automatically: false });
  await c.scheduleDraft(6, new Date('2026-10-09T07:00:00Z'), { sendEmail: true });
  assert.equal(calls[1]!.init.method, 'POST');
  assert.deepEqual(body(calls[1]!), { trigger_at: '2026-10-09T07:00:00.000Z', post_audience: 'everyone', email_audience: 'everyone' });
  await c.cancelSchedule(7);
  assert.equal(calls[2]!.url, `${PUB}/api/v1/drafts/7/scheduled_release`);
  assert.equal(calls[2]!.init.method, 'POST');
  assert.deepEqual(body(calls[2]!), { trigger_at: null });

  let n = 0;
  await client(() => (++n < 3 ? json({}, 503) : json({}))).cancelSchedule(7);
  assert.equal(n, 3);
  let m = 0;
  await assert.rejects(client(() => { m++; return json({}, 503); }).scheduleDraft(1, new Date(), { sendEmail: false }));
  assert.equal(m, 1);
});

test('postNote: corpo completo, id stringa accettato, metodo POST', async () => {
  const calls: Call[] = [];
  const r = await client(() => json({ id: 'abc' }), calls).postNote(DOC);
  assert.equal(r.id, 'abc');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(body(calls[0]!), { bodyJson: DOC, tabId: 'for-you', surface: 'feed', replyMinimumRole: 'everyone' });
  await assert.rejects(client(() => json({ id: '' })).postNote(DOC), ApiShapeError);
  await assert.rejects(client(() => json({ id: 1.5 })).postNote(DOC), ApiShapeError);
});

test('schemi: profilo con id intero, campi opzionali nulli, bozza con id positivo', async () => {
  const p = await client(() => json({ id: 3, name: null, handle: null })).getProfile();
  assert.equal(p.name, null);
  await assert.rejects(client(() => json({ id: 1.5 })).getProfile(), ApiShapeError);
  const d = await client(() => json({ id: 4, draft_title: null, draft_subtitle: null, audience: null, x: 1 })).getDraft(4);
  assert.deepEqual(d, { id: 4, draft_title: null, draft_subtitle: null, audience: null, x: 1 });
  for (const bad of [{ id: 0 }, { id: -1 }, { id: 1.5 }, { id: 1, draft_title: 3 }, { id: 1, draft_subtitle: 3 }, { id: 1, audience: 3 }]) {
    await assert.rejects(client(() => json(bad)).getDraft(1), ApiShapeError, JSON.stringify(bad));
  }
  await assert.rejects(client(() => json({ id: 1.5 })).createDraft({ title: 'T', body: DOC, authorId: 1 }), ApiShapeError);
});
