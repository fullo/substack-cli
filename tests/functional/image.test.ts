import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { defaultSubstack, startFakeSubstack, VALID_SID } from '../helpers/fake-substack.ts';
import { sendJson } from '../helpers/fake-server.ts';
import type { Handler } from '../helpers/fake-server.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const CDN = 'https://substack-post-media.s3.amazonaws.com/public/images/cover.png';
const ARTICLE = '---\ntitle: Titolo di prova\n---\n\nTesto.\n';

/** Server finto con caricamento immagini e copertina persistente sulla bozza 1001. */
function withImages(opts: { failCoverPut?: boolean; ignoreCover?: boolean } = {}): Handler {
  let cover: string | null = null;
  return (req, res, raw) => {
    if (!String(req.headers.cookie ?? '').includes(`substack.sid=${VALID_SID}`)) return sendJson(res, { error: 'unauthorized' }, 401);
    if (req.method === 'POST' && req.path === '/api/v1/image') {
      const body = JSON.parse(req.body) as { image?: string };
      if (!body.image?.startsWith('data:image/png;base64,')) return sendJson(res, { error: 'bad image' }, 400);
      return sendJson(res, { url: CDN });
    }
    if (req.method === 'PUT' && req.path === '/api/v1/drafts/1001') {
      if (opts.failCoverPut) return sendJson(res, { error: 'boom' }, 500);
      const body = JSON.parse(req.body) as { cover_image?: string };
      if (body.cover_image !== undefined && !opts.ignoreCover) cover = body.cover_image;
      return sendJson(res, {});
    }
    if (req.method === 'GET' && req.path === '/api/v1/drafts/1001') return sendJson(res, { id: 1001, draft_title: 'Titolo di prova', cover_image: cover });
    return defaultSubstack(req, res, raw);
  };
}

async function setup(handler?: Handler) {
  const server = await startFakeSubstack(handler ?? withImages());
  const sb = await makeSandbox(server.url);
  const dir = join(sb.configDir, '..');
  const png = join(dir, 'copertina.png');
  const article = join(dir, 'articolo.md');
  await writeFile(png, PNG);
  await writeFile(article, ARTICLE);
  return { server, sb, png, article, done: async () => { await sb.cleanup(); await server.stop(); } };
}

test('image upload: stampa l\'URL; con --json anche formato e dimensione', async () => {
  const { server, sb, png, done } = await setup();
  try {
    const r = await sb.run(['image', 'upload', png]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), CDN);
    const j = await sb.run(['image', 'upload', png, '--json']);
    assert.deepEqual(JSON.parse(j.stdout), { url: CDN, bytes: PNG.length, mime: 'image/png' });
    assert.equal(server.count('POST', '/api/v1/image'), 2);
  } finally { await done(); }
});

test('image upload --dry-run e file non valido: nessuna richiesta', async () => {
  const { server, sb, png, article, done } = await setup();
  try {
    const d = await sb.run(['image', 'upload', png, '--dry-run']);
    assert.equal(d.code, 0);
    assert.match(d.stdout, /dry-run/);
    const bad = await sb.run(['image', 'upload', article]);
    assert.equal(bad.code, 64);
    const none = await sb.run(['image', 'upload']);
    assert.equal(none.code, 64);
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});

test('article update --cover <file> --yes: carica, imposta e verifica la copertina', async () => {
  const { server, sb, png, done } = await setup();
  try {
    const r = await sb.run(['article', 'update', '1001', '--cover', png, '--yes', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.coverImage, CDN);
    assert.equal(out.changed.cover, true);
    const put = server.requests.find((q) => q.method === 'PUT')!;
    assert.deepEqual(JSON.parse(put.body), { cover_image: CDN });
  } finally { await done(); }
});

test('article update --cover <url>: nessun caricamento', async () => {
  const { server, sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'update', '1001', '--cover', CDN, '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(server.count('POST', '/api/v1/image'), 0);
    // Seconda volta: la copertina è già quella, nessuna modifica.
    const again = await sb.run(['article', 'update', '1001', '--cover', CDN, '--yes']);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /No changes/);
  } finally { await done(); }
});

test('article update --cover: non interattivo senza --yes, URL non https, --dry-run → nessuna scrittura', async () => {
  const { server, sb, png, done } = await setup();
  try {
    assert.equal((await sb.run(['article', 'update', '1001', '--cover', png])).code, 64);
    assert.equal((await sb.run(['article', 'update', '1001', '--cover', 'http://x.example/a.png', '--yes'])).code, 64);
    const dry = await sb.run(['article', 'update', '1001', '--cover', png, '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /cover: set from file/);
    assert.equal(server.count('POST', '/api/v1/image'), 0);
    assert.equal(server.requests.filter((q) => q.method === 'PUT').length, 0);
  } finally { await done(); }
});

test('article update --cover: copertina non riletta → exit 3 (API cambiata)', async () => {
  const { sb, done } = await setup(withImages({ ignoreCover: true }));
  try {
    const r = await sb.run(['article', 'update', '1001', '--cover', CDN, '--yes']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /cover/);
  } finally { await done(); }
});

test('article draft --cover: carica prima, crea la bozza, imposta la copertina', async () => {
  const { server, sb, article, png, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', article, '--cover', png, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.id, 1001);
    assert.match(out.url, /\/publish\/post\/1001$/);
    assert.equal(out.coverImage, CDN);
    const order = server.requests.map((q) => `${q.method} ${q.path}`);
    assert.ok(order.indexOf('POST /api/v1/image') < order.indexOf('POST /api/v1/drafts'), order.join(', '));
  } finally { await done(); }
});

test('article draft --cover con file non valido: nessuna bozza creata', async () => {
  const { server, sb, article, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', article, '--cover', article]);
    assert.equal(r.code, 64);
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});

test('article draft --cover: se il PUT fallisce, il messaggio dà id e comando per riprovare', async () => {
  const { sb, article, png, done } = await setup(withImages({ failCoverPut: true }));
  try {
    const r = await sb.run(['article', 'draft', article, '--cover', png]);
    assert.equal(r.code, 4);
    assert.match(r.stderr, /id 1001/);
    assert.match(r.stderr, new RegExp(`article update 1001 --cover ${CDN.replace(/[.]/g, '\\.')}`));
  } finally { await done(); }
});
