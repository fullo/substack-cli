import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import type { CliResult } from '../helpers/cli.ts';
import { defaultSubstack, startFakeSubstack, VALID_SID } from '../helpers/fake-substack.ts';
import { FakeServer, sendJson } from '../helpers/fake-server.ts';

// Tutte le forme in cui il cookie potrebbe uscire: così com'è, decodificato, ricodificato.
const SID_FORMS = [VALID_SID, decodeURIComponent(VALID_SID), encodeURIComponent(VALID_SID)];

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

function assertNoSid(r: CliResult, label: string): void {
  for (const s of SID_FORMS) {
    assert.ok(!r.stdout.includes(s), `${label}: cookie in stdout\n${r.stdout}`);
    assert.ok(!r.stderr.includes(s), `${label}: cookie in stderr\n${r.stderr}`);
  }
}

async function assertNoSidInFiles(dir: string): Promise<void> {
  for (const f of await allFiles(dir)) {
    const text = await readFile(f, 'utf8');
    for (const s of SID_FORMS) assert.ok(!text.includes(s), `cookie nel file ${f}`);
  }
}

test('il cookie non compare in stdout/stderr/--json/file di dati, nemmeno quando il server lo riflette negli errori', async () => {
  const server = await startFakeSubstack((req, res, raw) => {
    if (req.path === '/api/v1/user/profile/self') {
      return sendJson(res, { error: `cookie ${VALID_SID} rifiutato`, cookie: req.headers.cookie }, 500);
    }
    if (req.path === '/api/v1/comment/feed') {
      return sendJson(res, { error: `cookie ${decodeURIComponent(VALID_SID)} rifiutato`, cookie: req.headers.cookie }, 400);
    }
    defaultSubstack(req, res, raw);
  });
  const sb = await makeSandbox(server.url);
  try {
    const add = await sb.run(['note', 'add', 'x', '--json']);
    assert.equal(add.code, 0, add.stderr);
    const id = JSON.parse(add.stdout).id as string;
    const runs: [string, CliResult][] = [
      ['auth check', await sb.run(['auth', 'check'])],
      ['auth check --json', await sb.run(['auth', 'check', '--json'])],
      ['article list', await sb.run(['article', 'list'])],
      ['config show', await sb.run(['config', 'show'])],
      ['config show --json', await sb.run(['config', 'show', '--json'])],
      ['note add', add],
      ['note publish', await sb.run(['note', 'publish', id, '--json'])],
      ['note list', await sb.run(['note', 'list', '--json'])],
    ];
    assert.notEqual(runs[0]![1].code, 0, 'auth check deve fallire con un 500');
    for (const [label, r] of runs) assertNoSid(r, label);
    // Il messaggio d'errore della nota è salvato su file: anche lì nessun cookie.
    await assertNoSidInFiles(sb.dataDir);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('il cookie riflesso in risposte 200 (nome, titoli) viene redatto in output umano e --json', async () => {
  const server = await startFakeSubstack((req, res, raw) => {
    if (req.path === '/api/v1/user/profile/self') {
      return sendJson(res, { id: 42, name: `Ada ${VALID_SID}`, handle: decodeURIComponent(VALID_SID) });
    }
    if (req.path.startsWith('/api/v1/post_management/drafts')) {
      return sendJson(res, { posts: [{ id: 1001, draft_title: `substack.sid=${VALID_SID}` }] });
    }
    defaultSubstack(req, res, raw);
  });
  const sb = await makeSandbox(server.url);
  try {
    for (const args of [['auth', 'check'], ['auth', 'check', '--json'], ['article', 'list'], ['article', 'list', '--json']]) {
      const r = await sb.run(args);
      assert.equal(r.code, 0, r.stderr);
      assertNoSid(r, args.join(' '));
      assert.match(r.stdout, /\[REDACTED\]/);
    }
  } finally { await sb.cleanup(); await server.stop(); }
});

test('auth set da stdin: il cookie finisce solo in secrets.json, mai in output o nella cartella dati', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url, { SUBSTACK_SID: '' });
  try {
    const r = await sb.run(['auth', 'set', '--json'], { stdin: `substack.sid=${VALID_SID};\n` });
    assert.equal(r.code, 0, r.stderr);
    assertNoSid(r, 'auth set');
    await assertNoSidInFiles(sb.dataDir);
    const files = await allFiles(sb.configDir);
    const withSid = [];
    for (const f of files) if ((await readFile(f, 'utf8')).includes(VALID_SID)) withSid.push(f);
    assert.deepEqual(withSid, [join(sb.configDir, 'secrets.json')]);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('SUBSTACK_DEBUG=1 non stampa il cookie nemmeno negli stack trace', async () => {
  const server = await startFakeSubstack();
  // La cartella dati è un FILE il cui nome contiene il cookie: "notes run-due" fallisce con un
  // errore interno (ENOTDIR, non CliError) il cui messaggio e stack contengono quel percorso.
  const sb = await makeSandbox(server.url);
  const trap = join(sb.configDir, `..`, `trap-${VALID_SID}`);
  try {
    await mkdir(sb.configDir, { recursive: true });
    await writeFile(trap, 'non una cartella');
    const r = await sb.run(['notes', 'run-due'], { env: { SUBSTACK_DEBUG: '1', SUBSTACK_CLI_DATA_DIR: trap } });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Errore interno/);
    assert.match(r.stderr, /\n\s+at /, 'con SUBSTACK_DEBUG=1 lo stack deve essere stampato');
    assert.match(r.stderr, /\[REDACTED\]/);
    assertNoSid(r, 'run-due debug');

    const pub = await sb.run(['article', 'publish', 'abc', '--yes'], { env: { SUBSTACK_DEBUG: '1' } });
    assert.equal(pub.code, 64);
    assertNoSid(pub, 'publish debug');
    assert.equal(server.requests.length, 0);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('la chiave Anthropic non viene mai inviata a generate.baseUrl (server LLM locale/di rete)', async () => {
  const sub = await startFakeSubstack();
  const llm = await FakeServer.start((_req, res) => sendJson(res, { content: [{ type: 'text', text: 'x' }] }));
  // Proxy irraggiungibile: la richiesta verso api.anthropic.com fallisce in locale, senza uscire su Internet.
  const sb = await makeSandbox(sub.url, {
    ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000', NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
  });
  try {
    await mkdir(sb.configDir, { recursive: true });
    await writeFile(join(sb.configDir, 'config.json'), JSON.stringify({
      generate: { provider: 'openai-compat', model: 'locale', baseUrl: llm.url },
    }));
    const r = await sb.run(['generate', 'article', '--topic', 'x', '--provider', 'anthropic']);
    assert.equal(r.code, 5, r.stderr);
    assert.equal(llm.requests.filter((q) => q.headers['x-api-key'] !== undefined).length, 0);
    assert.equal(llm.requests.length, 0);
    assert.ok(!r.stderr.includes('sk-ant-test-0000000000000000'));
  } finally { await sb.cleanup(); await sub.stop(); await llm.stop(); }
});
