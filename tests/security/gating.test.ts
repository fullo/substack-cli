import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { startFakeSubstack } from '../helpers/fake-substack.ts';
import { FakeServer, sendJson } from '../helpers/fake-server.ts';

const PUBLISH_OR_SCHEDULE = /\/api\/v1\/drafts\/[^/]+\/(publish|scheduled_release)/;

test('nessuna combinazione non interattiva pubblica senza --yes', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    for (const args of [
      ['article', 'publish', '1001'],
      ['article', 'publish', '1001', '--send-email'],
      ['article', 'publish', '1001', '--json'],
      ['article', 'publish', '1001', '--yes=false'],
      ['article', 'publish', '1001', '--yes=true'],
      ['article', 'publish', '1001', '--yes='],
      ['article', 'publish', '1001', '-y'],
      ['article', 'publish', '1001', '--no-yes'],
      ['article', 'publish', '1001', '--YES'],
      ['article', 'publish', '1001', '--ye'],
      ['article', 'publish', '1001', 'yes'],
      ['article', 'publish', '1001', 'pubblica'],
      ['article', 'publish', '--', '1001', '--yes'],
      ['article', 'publish', '1001', '--dry-run=false'],
    ]) {
      const r = await sb.run(args, { stdin: 'pubblica\n' }); // anche con "pubblica" su stdin
      assert.notEqual(r.code, 0, args.join(' '));
      assert.ok(!/Pubblicato/.test(r.stdout), args.join(' '));
    }
    assert.equal(server.requests.filter((q) => PUBLISH_OR_SCHEDULE.test(q.path)).length, 0);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('--dry-run non pubblica nemmeno con --yes e --send-email', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    const r = await sb.run(['article', 'publish', '1001', '--dry-run', '--yes', '--send-email', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).dryRun, true);
    assert.equal(server.requests.filter((q) => PUBLISH_OR_SCHEDULE.test(q.path)).length, 0);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('l\'email agli iscritti parte solo con --send-email esplicito', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    assert.equal((await sb.run(['article', 'publish', '1001', '--yes'])).code, 0);
    assert.equal((await sb.run(['article', 'schedule', '1001', '--at', '2999-01-01T00:00:00Z'])).code, 0);
    const pub = server.requests.find((q) => q.path === '/api/v1/drafts/1001/publish')!;
    assert.equal(JSON.parse(pub.body).send, false);
    const sch = server.requests.find((q) => q.path === '/api/v1/drafts/1001/scheduled_release')!;
    assert.equal(JSON.parse(sch.body).email_audience, 'no_one');
    // --send-email=false non è un modo per attivarla (né per bypassare il parsing)
    assert.equal((await sb.run(['article', 'publish', '1001', '--yes', '--send-email=true'])).code, 64);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('generate e note non pubblicano né schedulano articoli', async () => {
  const server = await startFakeSubstack();
  const model = await FakeServer.start((_req, res) =>
    sendJson(res, { choices: [{ message: { content: '---\ntitle: Generato\n---\n\nCorpo.' } }] }));
  const sb = await makeSandbox(server.url);
  try {
    await mkdir(sb.configDir, { recursive: true });
    await writeFile(join(sb.configDir, 'config.json'), JSON.stringify({
      generate: { provider: 'openai-compat', model: 'locale', baseUrl: model.url },
    }));
    const art = await sb.run(['generate', 'article', '--topic', 'x', '--draft']);
    assert.equal(art.code, 0, art.stderr);
    assert.equal(server.count('POST', '/api/v1/drafts'), 1); // solo la bozza
    const note = await sb.run(['generate', 'note', '--topic', 'x']);
    assert.equal(note.code, 0, note.stderr);
    assert.equal(server.requests.filter((q) => PUBLISH_OR_SCHEDULE.test(q.path)).length, 0);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 0); // la nota generata resta in draft
  } finally { await sb.cleanup(); await server.stop(); await model.stop(); }
});

test('SUBSTACK_NOW senza SUBSTACK_ALLOW_TEST_CLOCK=1 è ignorato (nessuna pubblicazione anticipata)', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url, { SUBSTACK_ALLOW_TEST_CLOCK: '' });
  try {
    const add = await sb.run(['note', 'add', 'x', '--json']);
    assert.equal(add.code, 0, add.stderr);
    const id = JSON.parse(add.stdout).id as string;
    assert.equal((await sb.run(['note', 'schedule', id, '--at', '2999-01-01T00:00:00Z'])).code, 0);
    for (const allow of ['', 'true', 'yes', '01', ' 1', '1 ', 'TRUE']) {
      const r = await sb.run(['notes', 'run-due'], { env: { SUBSTACK_NOW: '3000-01-01T00:00:00Z', SUBSTACK_ALLOW_TEST_CLOCK: allow } });
      assert.equal(r.code, 0, r.stderr);
      const dry = await sb.run(['notes', 'run-due', '--dry-run', '--json'], { env: { SUBSTACK_NOW: '3000-01-01T00:00:00Z', SUBSTACK_ALLOW_TEST_CLOCK: allow } });
      assert.deepEqual(JSON.parse(dry.stdout).due, [], `ALLOW_TEST_CLOCK=${JSON.stringify(allow)}`);
    }
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 0);
    // Controprova: con il flag a "1" l'orologio finto vale davvero (il test sopra non è vacuo).
    const dry = await sb.run(['notes', 'run-due', '--dry-run', '--json'], { env: { SUBSTACK_NOW: '3000-01-01T00:00:00Z', SUBSTACK_ALLOW_TEST_CLOCK: '1' } });
    assert.deepEqual(JSON.parse(dry.stdout).due, [id]);
  } finally { await sb.cleanup(); await server.stop(); }
});
