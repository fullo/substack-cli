import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { startFakeSubstack } from '../helpers/fake-substack.ts';
import { FakeServer, sendJson } from '../helpers/fake-server.ts';

const llm = (text: string) => FakeServer.start((_req, res) => sendJson(res, { choices: [{ message: { content: text } }] }));

async function configure(sb: Awaited<ReturnType<typeof makeSandbox>>, llmUrl: string) {
  await mkdir(sb.configDir, { recursive: true });
  await writeFile(join(sb.configDir, 'config.json'), JSON.stringify({
    generate: { provider: 'openai-compat', model: 'locale', baseUrl: llmUrl },
  }));
}

test('generate article (openai-compat): salva il file; con --draft crea la bozza', async () => {
  const sub = await startFakeSubstack();
  const model = await llm('```markdown\n---\ntitle: Generato\n---\n\nCorpo **ok**.\n```');
  const sb = await makeSandbox(sub.url);
  try {
    await configure(sb, model.url);
    const r = await sb.run(['generate', 'article', '--topic', 'Rust', '--draft', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.draftId, 1001);
    assert.match(await readFile(out.file, 'utf8'), /^---\ntitle: Generato/);
    assert.equal(JSON.parse(model.requests[0]!.body).messages[1].content.includes('Rust'), true);
  } finally { await sb.cleanup(); await sub.stop(); await model.stop(); }
});

test('generate article senza --draft non contatta Substack', async () => {
  const sub = await startFakeSubstack();
  const model = await llm('---\ntitle: Solo file\n---\n\nTesto.');
  const sb = await makeSandbox(sub.url);
  try {
    await configure(sb, model.url);
    assert.equal((await sb.run(['generate', 'article', '--topic', 'x'])).code, 0);
    assert.equal(sub.requests.length, 0);
  } finally { await sb.cleanup(); await sub.stop(); await model.stop(); }
});

test('output non valido dell\'LLM: exit 5, testo grezzo salvato come rifiutato, nessuna bozza', async () => {
  const sub = await startFakeSubstack();
  const model = await llm('Nessun front-matter, solo testo <b>html</b>');
  const sb = await makeSandbox(sub.url);
  try {
    await configure(sb, model.url);
    const r = await sb.run(['generate', 'article', '--topic', 'x', '--draft']);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /rifiutato-/);
    const files = await readdir(join(sb.dataDir, 'drafts'));
    assert.equal(files.length, 1);
    assert.equal(sub.count('POST', '/api/v1/drafts'), 0);
  } finally { await sb.cleanup(); await sub.stop(); await model.stop(); }
});

test('generate note aggiunge una nota draft alla coda', async () => {
  const sub = await startFakeSubstack();
  const model = await llm('Una nota **breve**.');
  const sb = await makeSandbox(sub.url);
  try {
    await configure(sb, model.url);
    const r = await sb.run(['generate', 'note', '--topic', 'x']);
    assert.equal(r.code, 0, r.stderr);
    assert.match((await sb.run(['note', 'list', '--status', 'draft'])).stdout, /Una nota/);
  } finally { await sb.cleanup(); await sub.stop(); await model.stop(); }
});

test('LLM non raggiungibile → exit 5; senza --topic → exit 64; anthropic senza chiave → exit 5', async () => {
  const sub = await startFakeSubstack();
  const sb = await makeSandbox(sub.url);
  try {
    await configure(sb, 'http://127.0.0.1:1');
    assert.equal((await sb.run(['generate', 'article', '--topic', 'x'])).code, 5);
    assert.equal((await sb.run(['generate', 'article'])).code, 64);
    assert.equal((await sb.run(['generate', 'article', '--topic', 'x', '--provider', 'anthropic'])).code, 5);
  } finally { await sb.cleanup(); await sub.stop(); }
});
