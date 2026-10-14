import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubstackClient } from '../../../src/substack/client.ts';
import { ApiShapeError, NetworkError, UsageError } from '../../../src/util/errors.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call, Route } from '../../helpers/fetch.ts';

const PUB = 'https://pub.example';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CDN = 'https://substack-post-media.s3.amazonaws.com/public/images/abc.png';

function client(route: Route, calls: Call[] = []) {
  return new SubstackClient({
    sid: 's%3Aabc123def456.sig', publicationUrl: PUB, globalUrl: 'https://glob.example',
    fetchImpl: makeFetch(route, calls), sleep: async () => {},
  });
}

test('uploadImage: POST JSON con data URI sulla pubblicazione, restituisce l\'URL', async () => {
  const calls: Call[] = [];
  const r = await client(() => json({ url: CDN, imageWidth: 10 }), calls).uploadImage({ bytes: PNG, mime: 'image/png' });
  assert.equal(r.url, CDN);
  assert.equal(calls[0]!.url, `${PUB}/api/v1/image`);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(new Headers(calls[0]!.init.headers).get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { image: `data:image/png;base64,${PNG.toString('base64')}` });
});

test('uploadImage: non idempotente, nessun retry su errore del server', async () => {
  let n = 0;
  await assert.rejects(client(() => { n++; return json({}, 503); }).uploadImage({ bytes: PNG, mime: 'image/png' }), NetworkError);
  assert.equal(n, 1);
});

test('uploadImage: risposta senza url o con url non https → ApiShapeError', async () => {
  await assert.rejects(client(() => json({ id: 1 })).uploadImage({ bytes: PNG, mime: 'image/png' }), ApiShapeError);
  await assert.rejects(client(() => json({ url: 'http://cdn.example/a.png' })).uploadImage({ bytes: PNG, mime: 'image/png' }), ApiShapeError);
  await assert.rejects(client(() => json({ url: 'javascript:alert(1)' })).uploadImage({ bytes: PNG, mime: 'image/png' }), ApiShapeError);
});

test('updateDraft: coverImage diventa cover_image nel PUT parziale', async () => {
  const calls: Call[] = [];
  await client(() => json({}), calls).updateDraft(7, { coverImage: CDN });
  assert.equal(calls[0]!.url, `${PUB}/api/v1/drafts/7`);
  assert.equal(calls[0]!.init.method, 'PUT');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { cover_image: CDN });
});

test('updateDraft: coverImage non https viene rifiutato prima della rete', async () => {
  const calls: Call[] = [];
  await assert.rejects(client(() => json({}), calls).updateDraft(7, { coverImage: 'http://x.example/a.png' }), UsageError);
  assert.equal(calls.length, 0);
});

test('getDraft: cover_image è letta (anche null)', async () => {
  assert.equal((await client(() => json({ id: 7, cover_image: CDN })).getDraft(7)).cover_image, CDN);
  assert.equal((await client(() => json({ id: 7, cover_image: null })).getDraft(7)).cover_image, null);
});
