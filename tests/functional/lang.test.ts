import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { startFakeSubstack } from '../helpers/fake-substack.ts';

const ARTICLE = '---\ntitle: Titolo di prova\n---\n\nTesto.\n';

async function setup() {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  const file = join(sb.configDir, '..', 'articolo.md');
  await writeFile(file, ARTICLE);
  return { server, sb, file, done: async () => { await sb.cleanup(); await server.stop(); } };
}

test('lingua: inglese di default, italiano con SUBSTACK_LANG=it (anche nella forma it_IT.UTF-8)', async () => {
  const { sb, file, done } = await setup();
  try {
    assert.match((await sb.run(['article', 'draft', file])).stdout, /^Draft created: id 1001/);
    assert.match((await sb.run(['article', 'draft', file], { env: { SUBSTACK_LANG: 'it' } })).stdout, /^Bozza creata: id 1001/);
    assert.match((await sb.run(['article', 'draft', file], { env: { SUBSTACK_LANG: 'it_IT.UTF-8' } })).stdout, /^Bozza creata/);
    const err = await sb.run(['article', 'publish', 'x'], { env: { SUBSTACK_LANG: 'it' } });
    assert.match(err.stderr, /^Errore: Id bozza non valido/);
  } finally { await done(); }
});

test('lingua: "lang" in config.json attiva l\'italiano; SUBSTACK_LANG ha la precedenza', async () => {
  const { sb, file, done } = await setup();
  try {
    const init = await sb.run(['config', 'init', '--publication', 'testpub', '--lang', 'it']);
    assert.equal(init.code, 0, init.stderr);
    assert.match((await sb.run(['article', 'draft', file])).stdout, /^Bozza creata/);
    assert.match((await sb.run(['article', 'draft', file], { env: { SUBSTACK_LANG: 'en' } })).stdout, /^Draft created/);
    assert.equal(JSON.parse((await sb.run(['config', 'show', '--json'])).stdout).lang, 'it');
  } finally { await done(); }
});

test('lingua: valore non supportato → avviso e inglese; --lang non valido in config init → 64', async () => {
  const { sb, file, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', file], { env: { SUBSTACK_LANG: 'fr' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /SUBSTACK_LANG="fr" is not supported/);
    assert.match(r.stdout, /^Draft created/);
    assert.equal((await sb.run(['config', 'init', '--publication', 'testpub', '--lang', 'de'])).code, 64);
  } finally { await done(); }
});

test('lingua: help e guida seguono la lingua attiva', async () => {
  const { sb, done } = await setup();
  try {
    const en = (await sb.run(['help'])).stdout;
    assert.match(en, /^Usage: substack <group> <command> \[options\]/);
    assert.match(en, /List the most recent drafts/);
    const it = (await sb.run(['help'], { env: { SUBSTACK_LANG: 'it' } })).stdout;
    assert.match(it, /^Uso: substack <gruppo> <comando> \[opzioni\]/);
    assert.match(it, /Elenca le bozze più recenti/);
    assert.match((await sb.run(['auth', 'guide'])).stdout, /^GUIDE: getting your Substack session cookie/);
    assert.match((await sb.run(['auth', 'guide'], { env: { SUBSTACK_LANG: 'it' } })).stdout, /^GUIDA: ottenere il cookie/);
  } finally { await done(); }
});
