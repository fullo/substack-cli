import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox } from '../helpers/cli.ts';
import { defaultSubstack, startFakeSubstack } from '../helpers/fake-substack.ts';
import { sendJson } from '../helpers/fake-server.ts';

const T0 = { SUBSTACK_NOW: '2026-10-08T10:00:00Z' };
const T1 = { SUBSTACK_NOW: '2026-10-08T12:00:01Z' };

async function addScheduled(sb: Awaited<ReturnType<typeof makeSandbox>>, text: string) {
  const add = await sb.run(['note', 'add', text, '--json'], { env: T0 });
  assert.equal(add.code, 0, add.stderr);
  const id = JSON.parse(add.stdout).id as string;
  const sch = await sb.run(['note', 'schedule', id, '--at', '2026-10-08T12:00:00Z'], { env: T0 });
  assert.equal(sch.code, 0, sch.stderr);
  return id;
}

test('note: add → list → schedule → run-due pubblica solo a scadenza, una volta sola', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    const id = await addScheduled(sb, 'Ciao **mondo**');
    const list = await sb.run(['note', 'list', '--status', 'scheduled'], { env: T0 });
    assert.match(list.stdout, new RegExp(id));

    const early = await sb.run(['notes', 'run-due'], { env: T0 });
    assert.equal(early.code, 0);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 0);

    const due = await sb.run(['notes', 'run-due'], { env: T1 });
    assert.equal(due.code, 0, due.stderr);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 1);
    const posted = JSON.parse(server.requests.find((q) => q.path === '/api/v1/comment/feed')!.body);
    assert.equal(posted.bodyJson.type, 'doc');

    const again = await sb.run(['notes', 'run-due'], { env: T1 });
    assert.equal(again.code, 0);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 1);
    assert.match((await sb.run(['note', 'list', '--status', 'published'])).stdout, new RegExp(id));
  } finally { await sb.cleanup(); await server.stop(); }
});

test('crash/timeout durante la pubblicazione: nota in publishing, nessun doppio post, exit 6, poi resolve', async () => {
  const server = await startFakeSubstack((req, res, raw) => {
    if (req.path === '/api/v1/comment/feed') { raw.socket.destroy(); return; }
    defaultSubstack(req, res, raw);
  });
  const sb = await makeSandbox(server.url);
  try {
    const id = await addScheduled(sb, 'incerta');
    const first = await sb.run(['notes', 'run-due'], { env: T1 });
    assert.equal(first.code, 6, first.stderr);
    assert.match(first.stdout, /INCERTA/);
    const posts = server.count('POST', '/api/v1/comment/feed');
    assert.equal(posts, 1);

    const second = await sb.run(['notes', 'run-due'], { env: T1 });
    assert.equal(second.code, 6);
    assert.match(second.stdout, /BLOCCATA/);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), posts); // nessun secondo tentativo

    assert.equal((await sb.run(['note', 'resolve', id, '--published'])).code, 0);
    assert.equal((await sb.run(['notes', 'run-due'], { env: T1 })).code, 0);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('cookie scaduto durante run-due: exit 2 e la nota resta schedulata', async () => {
  const server = await startFakeSubstack((_req, res) => sendJson(res, {}, 401));
  const sb = await makeSandbox(server.url);
  try {
    const id = await addScheduled(sb, 'x');
    const r = await sb.run(['notes', 'run-due'], { env: T1 });
    assert.equal(r.code, 2);
    assert.match((await sb.run(['note', 'list', '--status', 'scheduled'])).stdout, new RegExp(id));
  } finally { await sb.cleanup(); await server.stop(); }
});

test('note publish immediata, unschedule, id non valido, note add da stdin e validazione', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    const add = await sb.run(['note', 'add', '-', '--json'], { stdin: 'da stdin\n', env: T0 });
    const id = JSON.parse(add.stdout).id as string;
    const pub = await sb.run(['note', 'publish', id], { env: T0 });
    assert.equal(pub.code, 0, pub.stderr);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 1);
    assert.equal((await sb.run(['note', 'publish', id])).code, 6); // già pubblicata

    const id2 = await addScheduled(sb, 'altra');
    assert.equal((await sb.run(['note', 'unschedule', id2])).code, 0);
    assert.equal((await sb.run(['notes', 'run-due'], { env: T1 })).code, 0);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 1);

    assert.equal((await sb.run(['note', 'publish', '../etc/passwd'])).code, 64);
    assert.equal((await sb.run(['note', 'add', '<script>x</script>'])).code, 64);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('notes run-due --dry-run non contatta Substack', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    await addScheduled(sb, 'x');
    const r = await sb.run(['notes', 'run-due', '--dry-run', '--json'], { env: T1 });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).due.length, 1);
    assert.equal(server.requests.length, 0);
  } finally { await sb.cleanup(); await server.stop(); }
});
