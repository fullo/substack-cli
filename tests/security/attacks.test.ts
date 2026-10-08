// Attacchi aggiuntivi scelti dopo la lettura di src/: id ostili su tutti i comandi che li accettano,
// argomenti ostili a "config init", file di coda manomessi, risposte HTTP ostili, sequenze di
// escape del terminale in testo non fidato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { makeSandbox } from '../helpers/cli.ts';
import { defaultSubstack, startFakeSubstack } from '../helpers/fake-substack.ts';
import { sendJson } from '../helpers/fake-server.ts';

const HOSTILE_NOTE_IDS = [
  '../../../outside', '..\\..\\outside', '../aaaaaaaaaaaa', 'aaaaaaaaaaaa/../../x', '/etc/passwd', 'C:\\Windows\\win.ini',
  'AAAAAAAAAAAA', 'aaaaaaaaaaa', 'aaaaaaaaaaaaa', 'aaaaaaaaaaaa.json', '%2e%2e%2f', 'aaaaaaaaaaaa\n', ' aaaaaaaaaaaa',
  '..', '.notes', '',
];
const HOSTILE_DRAFT_IDS = [
  '1001/../../x', '1001?send=true', '1001#x', '01001', '-1', '0', '1e3', '0x3e9', '１００１', '1001\n', ' 1001', '1001.0',
  '9'.repeat(16), '../1001', '1001/publish',
];

test('id ostili su ogni comando che accetta un id: exit 64, nessuna richiesta, nessun file fuori dalla coda', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  const root = dirname(sb.dataDir);
  try {
    const add = await sb.run(['note', 'add', 'vera', '--json']);
    assert.equal(add.code, 0, add.stderr);
    // Ogni id contro un comando a rotazione (i primi della lista, i più pericolosi, toccano tutti i
    // comandi): la validazione è comune, e un processo per combinazione renderebbe il test lento.
    const noteCommands = (id: string) => [
      ['note', 'schedule', id, '--at', '2999-01-01T00:00:00Z'], ['note', 'unschedule', id], ['note', 'publish', id],
      ['note', 'resolve', id, '--published'], ['note', 'resolve', id, '--retry'],
    ];
    const draftCommands = (id: string) => [
      ['article', 'publish', id, '--yes'], ['article', 'publish', id, '--dry-run'],
      ['article', 'schedule', id, '--at', '2999-01-01T00:00:00Z'], ['article', 'schedule', id, '--cancel'],
    ];
    const runs = [
      ...HOSTILE_NOTE_IDS.map((id, i) => noteCommands(id)[i % 5]!),
      ...HOSTILE_DRAFT_IDS.map((id, i) => draftCommands(id)[i % 4]!),
    ];
    for (const args of runs) {
      const r = await sb.run(args);
      assert.equal(r.code, 64, `${args.join(' ')} → ${r.code} ${r.stderr}`);
    }
    assert.deepEqual(server.requests.map((q) => `${q.method} ${q.path}`), []);
    assert.deepEqual((await readdir(root)).sort(), ['data']); // niente creato accanto alla sandbox
    const notes = (await readdir(join(sb.dataDir, 'notes'))).filter((n) => !n.startsWith('.'));
    assert.deepEqual(notes, [`${JSON.parse(add.stdout).id}.json`]);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('config init con argomenti ostili: non scrive mai una config non valida e non distrugge quella esistente', async () => {
  const server = await startFakeSubstack();
  // La sandbox imposta SUBSTACK_PUBLICATION e SUBSTACK_BASE_URL (validi): non devono mascherare
  // i valori ostili passati a config init.
  const sb = await makeSandbox(server.url);
  const configPath = join(sb.configDir, 'config.json');
  try {
    for (const args of [
      ['--publication', 'evil.example/x'], ['--publication', '../../x'], ['--publication', 'UPPER'],
      ['--publication', 'ok', '--llm-base-url', 'file:///etc/passwd'], ['--publication', 'ok', '--llm-base-url', 'http://u:p@host'],
      ['--publication', 'ok', '--provider', 'evil'], ['--publication', 'ok', '--provider', 'anthropic', '--force=1'],
    ]) {
      const r = await sb.run(['config', 'init', ...args]);
      assert.notEqual(r.code, 0, `${args.join(' ')} → accettato`);
      assert.equal(await readFile(configPath, 'utf8').catch(() => undefined), undefined, `${args.join(' ')} → file scritto`);
    }
    const ok = await sb.run(['config', 'init', '--publication', 'buona']);
    assert.equal(ok.code, 0, ok.stderr);
    const before = await readFile(configPath, 'utf8');
    const bad = await sb.run(['config', 'init', '--publication', 'buona', '--llm-base-url', 'file:///etc/passwd', '--force']);
    assert.equal(bad.code, 64);
    assert.equal(await readFile(configPath, 'utf8').catch(() => 'CANCELLATO'), before);
    // Senza variabili d'ambiente la config scritta è valida.
    const show = await sb.run(['config', 'show', '--json'], { env: { SUBSTACK_PUBLICATION: '', SUBSTACK_BASE_URL: '' } });
    assert.equal(show.code, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).publication, 'buona');
  } finally { await sb.cleanup(); await server.stop(); }
});

test('file di coda manomesso (id interno diverso dal nome del file): nessuna doppia pubblicazione, la coda non si blocca', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  const T0 = { SUBSTACK_NOW: '2026-10-08T10:00:00Z' };
  try {
    const ids: string[] = [];
    for (const [text, at] of [['prima', '2026-10-08T11:00:00Z'], ['seconda', '2026-10-08T11:30:00Z']] as const) {
      const add = await sb.run(['note', 'add', text, '--json'], { env: T0 });
      const id = JSON.parse(add.stdout).id as string;
      assert.equal((await sb.run(['note', 'schedule', id, '--at', at], { env: T0 })).code, 0);
      ids.push(id);
    }
    // Copia (es. "duplica nota" a mano) del file della prima nota sotto un altro nome.
    const dir = join(sb.dataDir, 'notes');
    await copyFile(join(dir, `${ids[0]}.json`), join(dir, '000000000000.json'));

    const T1 = { SUBSTACK_NOW: '2026-10-08T12:00:00Z' };
    const r1 = await sb.run(['notes', 'run-due', '--json'], { env: T1 });
    const r2 = await sb.run(['notes', 'run-due', '--json'], { env: T1 });
    const posted = server.requests.filter((q) => q.path === '/api/v1/comment/feed')
      .map((q) => JSON.stringify(JSON.parse(q.body).bodyJson));
    assert.equal(posted.length, 2, `richieste: ${posted.length}\n${r1.stdout}${r1.stderr}\n${r2.stdout}${r2.stderr}`);
    assert.ok(posted[0]!.includes('prima') && posted[1]!.includes('seconda'));
    const out = JSON.parse(r1.stdout);
    assert.deepEqual(out.published, ids);
    assert.deepEqual(out.corrupt, ['000000000000.json']);
    assert.equal(r1.code, 6); // il file manomesso va segnalato
  } finally { await sb.cleanup(); await server.stop(); }
});

test('risposta enorme senza content-length: il trasferimento viene interrotto, non letto per intero', async () => {
  const TOTAL = 64 * 1024 * 1024;
  let sentBeforeClose = -1;
  const stream = (res: ServerResponse) => {
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    res.writeHead(200, { 'content-type': 'application/json' }); // chunked: nessun content-length
    res.on('close', () => { sentBeforeClose = sent; });
    const pump = () => {
      while (sent < TOTAL) {
        sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    pump();
  };
  const server = await startFakeSubstack((req, res, raw) => {
    if (req.path === '/api/v1/comment/feed') return stream(res);
    defaultSubstack(req, res, raw);
  });
  const sb = await makeSandbox(server.url);
  try {
    const add = await sb.run(['note', 'add', 'x', '--json']);
    const id = JSON.parse(add.stdout).id as string;
    const r = await sb.run(['note', 'publish', id]);
    assert.equal(r.code, 6, r.stderr); // esito incerto: la richiesta è partita
    assert.match(r.stderr, /troppo grande/);
    for (let i = 0; i < 50 && sentBeforeClose < 0; i++) await new Promise((ok) => setTimeout(ok, 20));
    assert.ok(sentBeforeClose >= 0 && sentBeforeClose < 32 * 1024 * 1024, `byte inviati prima della chiusura: ${sentBeforeClose}`);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('testo non fidato (titoli dal server, front-matter, YAML) non arriva al terminale con sequenze di escape', async () => {
  const ESC_TITLE = 'ok\u001b]0;pwned\u0007\u001b[2J\u009b31m\rfine';
  const server = await startFakeSubstack((req, res, raw) => {
    if (req.path.startsWith('/api/v1/post_management/drafts')) return sendJson(res, { posts: [{ id: 1001, draft_title: ESC_TITLE }] });
    if (req.path === '/api/v1/drafts/1001') return sendJson(res, { id: 1001, draft_title: ESC_TITLE });
    defaultSubstack(req, res, raw);
  });
  const sb = await makeSandbox(server.url);
  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  try {
    await mkdir(sb.configDir, { recursive: true });
    const a = join(sb.configDir, 'a.md');
    await writeFile(a, '---\ntitle: [\u001b]0;pwned\u0007\n---\n\nx\n');
    const b = join(sb.configDir, 'b.md');
    await writeFile(b, '---\ntitle: *x: y\nsubtitle: !!weird z\n---\n\nx\n');
    for (const args of [
      ['article', 'list'], ['article', 'publish', '1001', '--yes'], ['article', 'publish', '1001', '--dry-run'],
      ['article', 'draft', a, '--dry-run'], ['article', 'draft', b, '--dry-run'],
    ]) {
      const r = await sb.run(args);
      assert.ok(!CONTROL.test(r.stdout), `${args.join(' ')}: stdout ${JSON.stringify(r.stdout)}`);
      assert.ok(!CONTROL.test(r.stderr), `${args.join(' ')}: stderr ${JSON.stringify(r.stderr)}`);
      assert.ok(!/YAMLWarning/.test(r.stderr), `${args.join(' ')}: avvisi della libreria YAML su stderr`);
    }
    // --json resta JSON valido e conserva il dato (gli escape di JSON lo rendono innocuo).
    const j = await sb.run(['article', 'list', '--json']);
    assert.equal(JSON.parse(j.stdout)[0].title, ESC_TITLE);
  } finally { await sb.cleanup(); await server.stop(); }
});
