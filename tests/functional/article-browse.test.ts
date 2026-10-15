import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { sendJson } from '../helpers/fake-server.ts';
import type { Handler } from '../helpers/fake-server.ts';
import { defaultSubstack, startFakeSubstack } from '../helpers/fake-substack.ts';

const doc = { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Ciao ' }, { type: 'text', text: 'mondo', marks: [{ type: 'strong' }] }] },
  { type: 'subscribeWidget' },
] };

const handler: Handler = (req, res, raw) => {
  if (req.method === 'GET' && req.path.startsWith('/api/v1/post_management/published')) {
    return sendJson(res, { posts: [{ id: 2001, title: 'Pubblicato', slug: 'pubblicato', post_date: '2026-10-01T00:00:00Z' }] });
  }
  if (req.method === 'GET' && req.path.startsWith('/api/v1/archive')) {
    return sendJson(res, [{ id: 2002, title: 'Trovato', slug: 'trovato', canonical_url: 'https://x.substack.com/p/trovato' }]);
  }
  if (req.method === 'GET' && req.path === '/api/v1/drafts/2001') {
    return sendJson(res, { id: 2001, draft_title: 'Pubblicato', draft_subtitle: 'Sotto', is_published: true, draft_body: JSON.stringify(doc) });
  }
  return defaultSubstack(req, res, raw);
};

async function setup() {
  const server = await startFakeSubstack(handler);
  const sb = await makeSandbox(server.url);
  return { server, sb, done: async () => { await sb.cleanup(); await server.stop(); } };
}

test('article list --status published: id, titolo, link e una sola richiesta con offset e limite', async () => {
  const { server, sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'list', '--status', 'published', '--limit', '10', '--page', '3']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^2001\tPubblicato\thttps?:\/\/[^\s]+\/p\/pubblicato$/m);
    const reqs = server.requests.filter((q) => q.path.startsWith('/api/v1/post_management/published'));
    assert.equal(reqs.length, 1);
    assert.match(reqs[0]!.path, /offset=20&limit=10/);
  } finally { await done(); }
});

test('article list --search usa la ricerca e restituisce id, titolo, link', async () => {
  const { server, sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'list', '--search', 'green coding & più']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^2002\tTrovato\thttps:\/\/x\.substack\.com\/p\/trovato$/m);
    const q = server.requests.find((x) => x.path.startsWith('/api/v1/archive'))!;
    assert.match(q.path, /^\/api\/v1\/archive\?sort=new&search=green%20coding%20%26%20pi%C3%B9/);
  } finally { await done(); }
});

test('article list: opzioni non valide sono rifiutate prima di qualsiasi richiesta', async () => {
  const { server, sb, done } = await setup();
  try {
    for (const args of [['--limit', '30'], ['--page', '0'], ['--status', 'x'], ['--search', 'a', '--status', 'draft'], ['--search', '  ']]) {
      const r = await sb.run(['article', 'list', ...args]);
      assert.notEqual(r.code, 0, args.join(' '));
    }
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});

test('article list senza opzioni resta sulle bozze', async () => {
  const { sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'list', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout)[0].id, 1001);
  } finally { await done(); }
});

test('article export scrive Markdown con front-matter e segnala i nodi non esportabili', async () => {
  const { server, sb, done } = await setup();
  try {
    const file = join(dirname(sb.dataDir), 'out.md');
    const r = await sb.run(['article', 'export', '2001', '--out', file]);
    assert.equal(r.code, 0, r.stderr);
    const text = await readFile(file, 'utf8');
    assert.match(text, /^---\ntitle: Pubblicato\nsubtitle: Sotto\n---\n\nCiao \*\*mondo\*\*/);
    assert.match(text, /subscribeWidget/);
    assert.match(r.stderr, /subscribeWidget/);
    assert.equal(server.requests.filter((q) => q.path.startsWith('/api/v1/drafts/')).length, 1);
    // non sovrascrive senza --force
    await writeFile(file, 'x');
    assert.notEqual((await sb.run(['article', 'export', '2001', '--out', file])).code, 0);
    assert.equal(await readFile(file, 'utf8'), 'x');
    assert.equal((await sb.run(['article', 'export', '2001', '--out', file, '--force'])).code, 0);
  } finally { await done(); }
});

test('article export su stdout', async () => {
  const { sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'export', '2001']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^---\ntitle: Pubblicato/);
  } finally { await done(); }
});
