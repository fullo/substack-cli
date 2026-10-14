import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { sendJson } from '../helpers/fake-server.ts';
import type { Handler } from '../helpers/fake-server.ts';
import { defaultSubstack, startFakeSubstack } from '../helpers/fake-substack.ts';

interface DraftState { draft_title: string; draft_subtitle: string; draft_body: string; is_published: boolean }

/** Bozza 1001 con stato: il PUT modifica i campi ricevuti e il GET successivo li restituisce. */
function statefulDraft(initial: Partial<DraftState> = {}, opts: { ignorePut?: boolean } = {}): { handler: Handler; state: DraftState } {
  const state: DraftState = {
    draft_title: '123 — Titolo con lineetta', draft_subtitle: 'Sottotitolo', draft_body: '{"type":"doc","content":[]}',
    is_published: false, ...initial,
  };
  const handler: Handler = (req, res, raw) => {
    if (req.path === '/api/v1/drafts/1001' && req.method === 'GET') return sendJson(res, { id: 1001, ...state });
    if (req.path === '/api/v1/drafts/1001' && req.method === 'PUT') {
      if (!opts.ignorePut) Object.assign(state, JSON.parse(req.body));
      return sendJson(res, { id: 1001, ...state });
    }
    return defaultSubstack(req, res, raw);
  };
  return { handler, state };
}

async function setup(initial: Partial<DraftState> = {}, opts: { ignorePut?: boolean } = {}) {
  const { handler, state } = statefulDraft(initial, opts);
  const server = await startFakeSubstack(handler);
  const sb = await makeSandbox(server.url);
  return { server, sb, state, done: async () => { await sb.cleanup(); await server.stop(); } };
}

const puts = (server: { requests: { method: string; path: string; body: string }[] }) =>
  server.requests.filter((q) => q.method === 'PUT' && q.path === '/api/v1/drafts/1001');

test('article update --title invia solo il titolo e verifica rileggendo la bozza', async () => {
  const { server, sb, state, done } = await setup();
  try {
    const r = await sb.run(['article', 'update', '1001', '--title', '123 - Titolo con trattino', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /titolo: "123 — Titolo con lineetta" → "123 - Titolo con trattino"/);
    assert.match(r.stdout, /Bozza 1001 aggiornata/);
    const sent = puts(server);
    assert.equal(sent.length, 1);
    assert.deepEqual(JSON.parse(sent[0]!.body), { draft_title: '123 - Titolo con trattino' });
    assert.equal(state.draft_title, '123 - Titolo con trattino');
    assert.equal(state.draft_subtitle, 'Sottotitolo');
    // lettura prima e dopo il PUT
    assert.equal(server.count('GET', '/api/v1/drafts/1001'), 2);
  } finally { await done(); }
});

test('article update --file sostituisce corpo, titolo e sottotitolo dal front-matter; --title prevale', async () => {
  const { server, sb, done } = await setup();
  try {
    const file = join(sb.configDir, '..', 'nuovo.md');
    await writeFile(file, '---\ntitle: Dal file\nsubtitle: Nuovo sottotitolo\n---\n\n## Sezione\n\nTesto.\n');
    const r = await sb.run(['article', 'update', '1001', '--file', file, '--title', 'Da opzione', '--yes', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.changed, { title: true, subtitle: true, body: true });
    assert.equal(out.title, 'Da opzione');
    const body = JSON.parse(puts(server)[0]!.body);
    assert.equal(body.draft_title, 'Da opzione');
    assert.equal(body.draft_subtitle, 'Nuovo sottotitolo');
    assert.deepEqual(JSON.parse(body.draft_body).content.map((n: { type: string }) => n.type), ['heading', 'paragraph']);
  } finally { await done(); }
});

test('article update --subtitle "" cancella il sottotitolo; --file da stdin senza subtitle lo azzera', async () => {
  const { server, sb, state, done } = await setup();
  try {
    assert.equal((await sb.run(['article', 'update', '1001', '--subtitle', '', '--yes'])).code, 0);
    assert.equal(state.draft_subtitle, '');
    state.draft_subtitle = 'Di nuovo';
    const r = await sb.run(['article', 'update', '1001', '--file', '-', '--yes'], { stdin: '---\ntitle: 123 — Titolo con lineetta\n---\n\nCorpo.\n' });
    assert.equal(r.code, 0, r.stderr);
    const last = JSON.parse(puts(server).at(-1)!.body);
    // titolo invariato: non inviato
    assert.equal('draft_title' in last, false);
    assert.equal(last.draft_subtitle, '');
    assert.ok('draft_body' in last);
  } finally { await done(); }
});

test('article update senza modifiche reali non invia il PUT', async () => {
  const { server, sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'update', '1001', '--title', '123 — Titolo con lineetta', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Nessuna modifica/);
    assert.equal(puts(server).length, 0);
  } finally { await done(); }
});

test('article update non interattivo senza --yes fallisce SENZA toccare Substack', async () => {
  const { server, sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'update', '1001', '--title', 'Nuovo']);
    assert.equal(r.code, 64);
    assert.match(r.stderr, /--yes/);
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});

test('article update --dry-run legge la bozza ma non invia il PUT', async () => {
  const { server, sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'update', '1001', '--title', 'Nuovo', '--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] Aggiornamento della bozza 1001/);
    assert.equal(puts(server).length, 0);
  } finally { await done(); }
});

test('article update rifiuta una bozza già pubblicata', async () => {
  const { server, sb, done } = await setup({ is_published: true });
  try {
    const r = await sb.run(['article', 'update', '1001', '--title', 'Nuovo', '--yes']);
    assert.equal(r.code, 64);
    assert.match(r.stderr, /già pubblicata/);
    assert.equal(puts(server).length, 0);
  } finally { await done(); }
});

test('article update: se Substack accetta ma non applica il titolo → exit 3', async () => {
  const { sb, done } = await setup({}, { ignorePut: true });
  try {
    const r = await sb.run(['article', 'update', '1001', '--title', 'Nuovo', '--yes']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /non risulta aggiornata \(titolo\)/);
  } finally { await done(); }
});

test('article update: input non valido → exit 64 e nessuna richiesta', async () => {
  const { server, sb, done } = await setup();
  try {
    assert.equal((await sb.run(['article', 'update', '1001', '--yes'])).code, 64);
    assert.equal((await sb.run(['article', 'update', '../1', '--title', 'X', '--yes'])).code, 64);
    assert.equal((await sb.run(['article', 'update', '1001', '--title', '', '--yes'])).code, 64);
    assert.equal((await sb.run(['article', 'update', '1001', '--title', 'a\nb', '--yes'])).code, 64);
    assert.equal((await sb.run(['article', 'update', '1001', '--title', 'x'.repeat(301), '--yes'])).code, 64);
    assert.equal((await sb.run(['article', 'update', '1001', '--file', '-', '--yes'], { stdin: 'senza front-matter' })).code, 64);
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});
