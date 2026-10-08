// Test aggiuntivi dall'analisi dei mutanti (Stryker): transizioni di stato complete (campi tolti e
// mantenuti), messaggi d'errore, confini, formato su disco, ordinamento stabile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NoteStore } from '../../../src/notes/store.ts';
import type { Note } from '../../../src/notes/store.ts';
import { StateError, UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const NOW = new Date('2026-10-08T10:00:00Z');
const LATER = new Date('2026-10-09T10:00:00Z');

async function put(dir: string, note: Note): Promise<void> {
  await writeFile(join(dir, `${note.id}.json`), JSON.stringify(note));
}

test('add: crea la cartella, formato su disco JSON indentato con a capo finale, limite di 5000 caratteri', async () => {
  await withTmpDir(async (root) => {
    const dir = join(root, 'a', 'notes');
    const store = new NoteStore(dir);
    assert.equal(store.dir, dir);
    assert.equal(store.lockPath, join(dir, '.lock'));
    const n = await store.add('x'.repeat(5000), NOW);
    const raw = await readFile(join(dir, `${n.id}.json`), 'utf8');
    assert.equal(raw, JSON.stringify(n, null, 2) + '\n');
    assert.deepEqual(Object.keys(n).sort(), ['createdAt', 'id', 'status', 'text']);
    await assert.rejects(store.add('x'.repeat(5001), NOW), (e: unknown) =>
      e instanceof UsageError && e.message === 'La nota supera i 5000 caratteri');
  });
});

test('id: messaggi d\'errore esatti (non valido, non trovato)', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await assert.rejects(store.get('../x'), (e: unknown) => e instanceof UsageError && e.message === 'Id nota non valido: "../x"');
    await assert.rejects(store.get('0123456789ab'), (e: unknown) => e instanceof UsageError && e.message === 'Nota non trovata: 0123456789ab');
    for (const bad of ['0123456789abc', 'x0123456789ab', '0123456789aB', '0123456789a']) {
      await assert.rejects(store.get(bad), /Id nota non valido/, bad);
    }
  });
});

test('get: errore di lettura diverso da ENOENT viene rilanciato così com\'è; file corrotto → messaggio con il percorso', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await mkdir(join(dir, '0123456789ab.json'));
    await assert.rejects(store.get('0123456789ab'), (e: unknown) => !(e instanceof UsageError) && !(e instanceof StateError));
    await writeFile(join(dir, 'aaaaaaaaaaaa.json'), '{}');
    await assert.rejects(store.get('aaaaaaaaaaaa'), (e: unknown) => e instanceof StateError &&
      e.message === `File nota corrotto o modificato in modo non valido: ${join(dir, 'aaaaaaaaaaaa.json')}`);
  });
});

test('schema: campi extra, id non coerente, testo vuoto o troppo lungo, prevStatus non valido sono corrotti', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const base: Note = { id: 'aaaaaaaaaaaa', text: 'x', status: 'draft', createdAt: NOW.toISOString() };
    const bads: Record<string, unknown>[] = [
      { ...base, extra: 1 }, { ...base, id: 'AAAAAAAAAAAA' }, { ...base, id: 'gaaaaaaaaaaaa' }, { ...base, id: 'aaaaaaaaaaaag' }, { ...base, text: '' }, { ...base, text: 'x'.repeat(5001) },
      { ...base, prevStatus: 'published' }, { ...base, publishAt: 1 }, { ...base, error: 1 }, { ...base, substackId: 1 },
      { ...base, publishedAt: 1 }, { ...base, createdAt: 1 },
    ];
    for (const bad of bads) {
      await writeFile(join(dir, 'aaaaaaaaaaaa.json'), JSON.stringify(bad));
      await assert.rejects(store.get('aaaaaaaaaaaa'), StateError, JSON.stringify(bad).slice(0, 80));
    }
    const full: Note = { ...base, text: 'x'.repeat(5000), status: 'publishing', publishAt: 'p', prevStatus: 'scheduled',
      publishedAt: 'q', substackId: 's', error: 'e' };
    await put(dir, full);
    assert.deepEqual(await store.get(full.id), full);
    for (const status of ['draft', 'scheduled', 'publishing', 'published', 'failed'] as const) {
      await put(dir, { ...base, status });
      assert.equal((await store.get(base.id)).status, status);
    }
  });
});

test('list: cartella assente → vuoto; altri errori rilanciati; ordinamento per data poi per id; filtri', async () => {
  await withTmpDir(async (root) => {
    assert.deepEqual(await new NoteStore(join(root, 'manca')).list(), { notes: [], corrupt: [] });
    const fileAsDir = join(root, 'file');
    await writeFile(fileAsDir, 'x');
    await assert.rejects(new NoteStore(fileAsDir).list(), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOTDIR');

    const dir = join(root, 'n');
    await mkdir(dir);
    const store = new NoteStore(dir);
    const mk = (id: string, createdAt: string, status: Note['status']): Note => ({ id, text: 't', status, createdAt });
    await put(dir, mk('bbbbbbbbbbbb', '2026-10-08T10:00:00.000Z', 'draft'));
    await put(dir, mk('aaaaaaaaaaaa', '2026-10-08T10:00:00.000Z', 'failed'));
    await put(dir, mk('cccccccccccc', '2026-10-08T09:00:00.000Z', 'draft'));
    await writeFile(join(dir, 'dddddddddddd.json.bak'), 'x');
    await writeFile(join(dir, 'xdddddddddddd.json'), 'x');
    const all = await store.list();
    assert.deepEqual(all.notes.map((n) => n.id), ['cccccccccccc', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    assert.deepEqual(all.corrupt, []);
    assert.deepEqual((await store.list('draft')).notes.map((n) => n.id), ['cccccccccccc', 'bbbbbbbbbbbb']);
    assert.deepEqual((await store.list('failed')).notes.map((n) => n.id), ['aaaaaaaaaaaa']);
    assert.deepEqual((await store.list('published')).notes, []);
  });
});

test('schedule: confine "adesso", messaggio, ripianificazione da scheduled, cancella error; vietato da altri stati', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await assert.rejects(store.schedule(n.id, NOW, NOW), (e: unknown) =>
      e instanceof UsageError && e.message === 'La data di pubblicazione deve essere nel futuro');
    const ok = await store.schedule(n.id, new Date(NOW.getTime() + 1), NOW);
    assert.equal(ok.publishAt, '2026-10-08T10:00:00.001Z');
    await store.beginPublish(n.id);
    await store.revert(n.id, 'cookie');
    const again = await store.schedule(n.id, LATER, NOW);
    assert.deepEqual(again, { id: n.id, text: 'x', status: 'scheduled', createdAt: NOW.toISOString(), publishAt: LATER.toISOString() });
    assert.deepEqual(await store.get(n.id), again);
    await store.beginPublish(n.id);
    await assert.rejects(store.schedule(n.id, LATER, NOW), (e: unknown) =>
      e instanceof StateError && e.message === `Nota ${n.id}: operazione non consentita dallo stato "publishing"`);
    await store.fail(n.id, 'no');
    await assert.rejects(store.schedule(n.id, LATER, NOW), StateError);
  });
});

test('unschedule toglie publishAt ed error, solo da scheduled', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await assert.rejects(store.unschedule(n.id), StateError);
    await store.schedule(n.id, LATER, NOW);
    await store.beginPublish(n.id);
    await store.revert(n.id, 'cookie');
    const back = await store.unschedule(n.id);
    assert.deepEqual(back, { id: n.id, text: 'x', status: 'draft', createdAt: NOW.toISOString() });
  });
});

test('beginPublish: ricorda lo stato precedente, toglie error, mantiene publishAt', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await store.schedule(n.id, LATER, NOW);
    await store.beginPublish(n.id);
    await store.revert(n.id, 'cookie');
    const p = await store.beginPublish(n.id);
    assert.deepEqual(p, { id: n.id, text: 'x', status: 'publishing', createdAt: NOW.toISOString(),
      publishAt: LATER.toISOString(), prevStatus: 'scheduled' });
    for (const from of ['published', 'failed'] as const) {
      await put(dir, { id: 'aaaaaaaaaaaa', text: 't', status: from, createdAt: NOW.toISOString() });
      await assert.rejects(store.beginPublish('aaaaaaaaaaaa'), StateError, from);
    }
  });
});

test('completePublish: toglie prevStatus ed error, registra id e data; solo da publishing', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await assert.rejects(store.completePublish(n.id, 's', NOW), StateError);
    await store.beginPublish(n.id);
    await store.markUncertain(n.id, 'timeout');
    const done = await store.completePublish(n.id, 's-1', LATER);
    assert.deepEqual(done, { id: n.id, text: 'x', status: 'published', createdAt: NOW.toISOString(),
      substackId: 's-1', publishedAt: LATER.toISOString() });
  });
});

test('revert: torna a prevStatus (draft se assente), con error; fail toglie prevStatus; solo da publishing', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await assert.rejects(store.revert(n.id, 'e'), StateError);
    await assert.rejects(store.fail(n.id, 'e'), StateError);
    await assert.rejects(store.markUncertain(n.id, 'e'), StateError);
    await store.beginPublish(n.id);
    const r = await store.revert(n.id, 'cookie');
    assert.deepEqual(r, { id: n.id, text: 'x', status: 'draft', createdAt: NOW.toISOString(), error: 'cookie' });

    await put(dir, { id: 'aaaaaaaaaaaa', text: 't', status: 'publishing', createdAt: NOW.toISOString() });
    assert.equal((await store.revert('aaaaaaaaaaaa', 'e')).status, 'draft');

    await store.beginPublish(n.id);
    const f = await store.fail(n.id, 'rifiutata');
    assert.deepEqual(f, { id: n.id, text: 'x', status: 'failed', createdAt: NOW.toISOString(), error: 'rifiutata' });
  });
});

test('markUncertain conserva tutto e aggiunge error', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await store.schedule(n.id, LATER, NOW);
    await store.beginPublish(n.id);
    const u = await store.markUncertain(n.id, 'timeout');
    assert.deepEqual(u, { id: n.id, text: 'x', status: 'publishing', createdAt: NOW.toISOString(),
      publishAt: LATER.toISOString(), prevStatus: 'scheduled', error: 'timeout' });
  });
});

test('resolve: published toglie prevStatus/error e registra la data; retry torna a prevStatus (draft se assente)', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await store.schedule(n.id, LATER, NOW);
    await store.beginPublish(n.id);
    await store.markUncertain(n.id, 'timeout');
    const back = await store.resolve(n.id, 'retry', NOW);
    assert.deepEqual(back, { id: n.id, text: 'x', status: 'scheduled', createdAt: NOW.toISOString(), publishAt: LATER.toISOString() });
    await store.beginPublish(n.id);
    await store.markUncertain(n.id, 'timeout');
    const pub = await store.resolve(n.id, 'published', LATER);
    assert.deepEqual(pub, { id: n.id, text: 'x', status: 'published', createdAt: NOW.toISOString(),
      publishAt: LATER.toISOString(), publishedAt: LATER.toISOString() });
    await put(dir, { id: 'aaaaaaaaaaaa', text: 't', status: 'publishing', createdAt: NOW.toISOString() });
    assert.equal((await store.resolve('aaaaaaaaaaaa', 'retry', NOW)).status, 'draft');
  });
});
