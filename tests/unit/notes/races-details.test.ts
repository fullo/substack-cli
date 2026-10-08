// Test aggiuntivi dall'analisi dei mutanti (Stryker) sulle modifiche della revisione di sicurezza:
// stati ammessi di default, stato locale non aggiornabile dopo un errore, note già pubblicate non
// riconsiderate, messaggio di lock perso, errori di beginPublish annotati.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NoteStore } from '../../../src/notes/store.ts';
import type { Note } from '../../../src/notes/store.ts';
import { publishOne, runDue } from '../../../src/notes/publish.ts';
import { AuthError, NetworkError, StateError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const T0 = new Date('2026-10-08T10:00:00Z');
const NOW = new Date('2026-10-08T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

async function scheduled(store: NoteStore, text: string, when: Date): Promise<Note> {
  const n = await store.add(text, T0);
  return store.schedule(n.id, when, T0);
}

test('publishOne senza from: ammessi sia draft sia scheduled', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const d = await store.add('d', T0);
    const s = await scheduled(store, 's', at(10));
    assert.equal((await publishOne(store, d.id, async () => ({ id: '1' }), NOW)).kind, 'published');
    assert.equal((await publishOne(store, s.id, async () => ({ id: '2' }), NOW)).kind, 'published');
  });
});

test('publishOne: errore di invio e stato locale non aggiornabile → esito incerto con entrambi i messaggi', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', T0);
    const out = await publishOne(store, n.id, async () => {
      await rm(join(dir, `${n.id}.json`));
      throw new AuthError('scaduto');
    }, NOW);
    assert.equal(out.kind, 'uncertain');
    if (out.kind !== 'uncertain') return;
    assert.ok(out.error instanceof StateError);
    assert.equal(out.error.message, `scaduto; stato locale non aggiornato: Nota non trovata: ${n.id}`);
  });
});

test('runDue: le note già pubblicate (con publishAt) non vengono riconsiderate né segnalate', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'x', at(10));
    await runDue(store, async () => ({ id: 'n' }), NOW);
    const second = await runDue(store, async () => ({ id: 'm' }), NOW);
    assert.deepEqual(second, { published: [], reverted: [], failed: [], uncertain: [], stuck: [], corrupt: [], authFailed: false });
  });
});

test('runDue: lock perso senza note pubblicate → messaggio senza elenco', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'a', at(10));
    await scheduled(store, 'b', at(20));
    await assert.rejects(runDue(store, async () => {
      await writeFile(store.lockPath, 'altro-processo');
      throw new NetworkError('timeout');
    }, NOW), (e: unknown) => e instanceof StateError &&
      e.message === `Lock perso: ${store.lockPath} è stato rimosso o preso in carico da un altro processo: run-due interrotto.`);
  });
});

test('runDue: lock perso dopo una pubblicazione → elenco delle note già pubblicate', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await scheduled(store, 'a', at(10));
    await scheduled(store, 'b', at(20));
    await assert.rejects(runDue(store, async () => {
      await writeFile(store.lockPath, 'altro-processo');
      return { id: 'x' };
    }, NOW), (e: unknown) => e instanceof StateError && e.message.endsWith(`: run-due interrotto. Già pubblicate: ${a.id}.`));
  });
});

class RefusingStore extends NoteStore {
  override async beginPublish(id: string, from?: ('draft' | 'scheduled')[]): Promise<Note> {
    if (id === this.refuse) throw new StateError('rifiutata');
    return super.beginPublish(id, from);
  }
  refuse = '';
}

test('runDue: se beginPublish fallisce, la nota finisce tra le fallite e il giro prosegue', async () => {
  await withTmpDir(async (dir) => {
    const store = new RefusingStore(dir);
    const a = await scheduled(store, 'a', at(10));
    const b = await scheduled(store, 'b', at(20));
    store.refuse = a.id;
    const r = await runDue(store, async () => ({ id: 'x' }), NOW);
    assert.deepEqual(r.failed, [{ id: a.id, error: 'rifiutata' }]);
    assert.deepEqual(r.published, [b.id]);
  });
});
