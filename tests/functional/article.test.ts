import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { startFakeSubstack, VALID_SID } from '../helpers/fake-substack.ts';

const ARTICLE = '---\ntitle: Titolo di prova\nsubtitle: Sottotitolo\n---\n\n## Intro\n\nTesto **forte** con [link](https://example.com).\n\n- uno\n- due\n';

async function setup() {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  const file = join(sb.configDir, '..', 'articolo.md');
  await writeFile(file, ARTICLE);
  return { server, sb, file, done: async () => { await sb.cleanup(); await server.stop(); } };
}

test('article draft da file crea la bozza con corpo ProseMirror e cookie corretto', async () => {
  const { server, sb, file, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', file]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Bozza creata: id 1001/);
    const post = server.requests.find((q) => q.method === 'POST' && q.path === '/api/v1/drafts')!;
    assert.match(String(post.headers.cookie), new RegExp(`substack.sid=${VALID_SID.replace(/\./g, '\\.')}`));
    const body = JSON.parse(post.body);
    assert.equal(body.draft_title, 'Titolo di prova');
    assert.equal(body.draft_subtitle, 'Sottotitolo');
    const doc = JSON.parse(body.draft_body);
    assert.equal(doc.type, 'doc');
    assert.deepEqual(doc.content.map((n: { type: string }) => n.type), ['heading', 'paragraph', 'bullet_list']);
    assert.deepEqual(body.draft_bylines, [{ id: 42, is_guest: false }]);
  } finally { await done(); }
});

test('article draft da stdin e --json', async () => {
  const { sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', '-', '--json'], { stdin: ARTICLE });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).id, 1001);
  } finally { await done(); }
});

test('article draft --dry-run non fa nessuna richiesta', async () => {
  const { server, sb, file, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', file, '--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /dry-run/);
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});

test('Markdown non valido → exit 64 e nessuna richiesta', async () => {
  const { server, sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', '-'], { stdin: '---\ntitle: T\n---\n\n[x](javascript:alert(1))' });
    assert.equal(r.code, 64);
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});

test('article list', async () => {
  const { sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'list']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /1001\tTitolo di prova/);
  } finally { await done(); }
});

test('article publish non interattivo: senza --yes fallisce SENZA toccare Substack', async () => {
  const { server, sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'publish', '1001']);
    assert.equal(r.code, 64);
    assert.match(r.stderr, /--yes/);
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});

test('article publish --yes: senza email di default, con --send-email invia', async () => {
  const { server, sb, done } = await setup();
  try {
    assert.equal((await sb.run(['article', 'publish', '1001', '--yes'])).code, 0);
    assert.equal(JSON.parse(server.requests.find((q) => q.path.endsWith('/publish'))!.body).send, false);
    assert.equal((await sb.run(['article', 'publish', '1001', '--yes', '--send-email'])).code, 0);
    const sends = server.requests.filter((q) => q.path.endsWith('/publish')).map((q) => JSON.parse(q.body).send);
    assert.deepEqual(sends, [false, true]);
  } finally { await done(); }
});

test('article publish --dry-run e id non valido', async () => {
  const { server, sb, done } = await setup();
  try {
    const dry = await sb.run(['article', 'publish', '1001', '--dry-run']);
    assert.equal(dry.code, 0);
    assert.equal(server.count('POST', '/api/v1/drafts/1001/publish'), 0);
    assert.equal((await sb.run(['article', 'publish', '../1', '--yes'])).code, 64);
  } finally { await done(); }
});

test('article schedule / cancel', async () => {
  const { server, sb, done } = await setup();
  try {
    const env = { SUBSTACK_NOW: '2026-10-08T10:00:00Z' };
    const ok = await sb.run(['article', 'schedule', '1001', '--at', '2026-10-09T09:00:00+02:00', '--yes'], { env });
    assert.equal(ok.code, 0, ok.stderr);
    const sch = JSON.parse(server.requests.find((q) => q.path.endsWith('/scheduled_release'))!.body);
    assert.equal(sch.trigger_at, '2026-10-09T07:00:00.000Z');
    assert.equal(sch.email_audience, 'no_one');
    assert.equal((await sb.run(['article', 'schedule', '1001', '--at', '2026-10-07T09:00:00Z'], { env })).code, 64);
    assert.equal((await sb.run(['article', 'schedule', '1001', '--at', '2026-10-09T09:00:00'], { env })).code, 64);
    assert.equal((await sb.run(['article', 'schedule', '1001'], { env })).code, 64);
    assert.equal((await sb.run(['article', 'schedule', '1001', '--cancel'], { env })).code, 0);
    const last = JSON.parse(server.requests.filter((q) => q.path.endsWith('/scheduled_release')).at(-1)!.body);
    assert.equal(last.trigger_at, null);
  } finally { await done(); }
});
