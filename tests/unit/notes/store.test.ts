import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NoteStore } from '../../../src/notes/store.ts';
import { StateError, UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const NOW = new Date('2026-10-08T10:00:00Z');

test('add crea una nota draft con id esadecimale di 12 caratteri', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('Ciao **mondo**', NOW);
    assert.match(n.id, /^[0-9a-f]{12}$/);
    assert.equal(n.status, 'draft');
    assert.equal(n.createdAt, NOW.toISOString());
    assert.deepEqual((await readdir(dir)).sort(), [`${n.id}.json`]);
    assert.deepEqual(await store.get(n.id), n);
  });
});

test('add valida il contenuto: vuoto, non supportato, troppo lungo', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await assert.rejects(store.add('', NOW), UsageError);
    await assert.rejects(store.add('<script>x</script>', NOW), UsageError);
    await assert.rejects(store.add('a'.repeat(5001), NOW), UsageError);
    assert.equal((await store.list()).notes.length, 0);
  });
});

test('gli id non esadecimali (path traversal) sono rifiutati', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    for (const bad of ['../x', '..\\x', 'abc', 'ZZZZZZZZZZZZ', '', '0123456789ab/..']) {
      await assert.rejects(store.get(bad), UsageError, bad);
    }
    await assert.rejects(store.get('0123456789ab'), UsageError); // valido ma inesistente
  });
});

test('list filtra per stato, ordina per creazione e segnala i file corrotti', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await store.add('a', new Date('2026-10-08T10:00:00Z'));
    const b = await store.add('b', new Date('2026-10-08T09:00:00Z'));
    await writeFile(join(dir, 'deadbeef0000.json'), '{ rotto');
    await writeFile(join(dir, 'altro.txt'), 'ignorato');
    const { notes, corrupt } = await store.list();
    assert.deepEqual(notes.map((n) => n.id), [b.id, a.id]);
    assert.deepEqual(corrupt, ['deadbeef0000.json']);
    await store.schedule(a.id, new Date('2026-10-09T10:00:00Z'), NOW);
    assert.deepEqual((await store.list('scheduled')).notes.map((n) => n.id), [a.id]);
  });
});

test('schedule richiede una data futura; unschedule torna a draft', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await assert.rejects(store.schedule(n.id, new Date('2026-10-08T09:00:00Z'), NOW), UsageError);
    const s = await store.schedule(n.id, new Date('2026-10-09T10:00:00Z'), NOW);
    assert.equal(s.status, 'scheduled');
    assert.equal(s.publishAt, '2026-10-09T10:00:00.000Z');
    const back = await store.unschedule(n.id);
    assert.equal(back.status, 'draft');
    assert.equal(back.publishAt, undefined);
    await assert.rejects(store.unschedule(n.id), StateError);
  });
});

test('transizioni di pubblicazione: begin → complete', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    const p = await store.beginPublish(n.id);
    assert.equal(p.status, 'publishing');
    assert.equal(p.prevStatus, 'draft');
    await assert.rejects(store.beginPublish(n.id), StateError); // già in corso
    const done = await store.completePublish(n.id, 'note-9', NOW);
    assert.equal(done.status, 'published');
    assert.equal(done.substackId, 'note-9');
    assert.equal(done.publishedAt, NOW.toISOString());
    await assert.rejects(store.beginPublish(n.id), StateError); // già pubblicata
  });
});

test('revert torna allo stato precedente; fail e markUncertain annotano l\'errore', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await store.schedule(n.id, new Date('2026-10-09T10:00:00Z'), NOW);
    await store.beginPublish(n.id);
    const r = await store.revert(n.id, 'cookie scaduto');
    assert.equal(r.status, 'scheduled');
    assert.equal(r.error, 'cookie scaduto');
    await store.beginPublish(n.id);
    const u = await store.markUncertain(n.id, 'timeout');
    assert.equal(u.status, 'publishing');
    assert.equal(u.error, 'timeout');
    await store.resolve(n.id, 'retry', NOW);
    await store.beginPublish(n.id);
    const f = await store.fail(n.id, 'rifiutata');
    assert.equal(f.status, 'failed');
    assert.equal(f.error, 'rifiutata');
  });
});

test('resolve: --published segna come pubblicata, --retry torna indietro; solo da publishing', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await store.add('a', NOW);
    await assert.rejects(store.resolve(a.id, 'retry', NOW), StateError);
    await store.beginPublish(a.id);
    const pub = await store.resolve(a.id, 'published', NOW);
    assert.equal(pub.status, 'published');
    assert.equal(pub.publishedAt, NOW.toISOString());
    const b = await store.add('b', NOW);
    await store.beginPublish(b.id);
    assert.equal((await store.resolve(b.id, 'retry', NOW)).status, 'draft');
  });
});

test('un file modificato a mano con stato non valido viene segnalato', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await writeFile(join(dir, `${n.id}.json`), JSON.stringify({ ...n, status: 'boh' }));
    await assert.rejects(store.get(n.id), StateError);
  });
});
