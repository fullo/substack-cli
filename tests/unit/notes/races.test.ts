// Regressioni della revisione di sicurezza: modifiche concorrenti alla coda durante run-due,
// aggiornamenti persi, errori di una singola nota che fermavano l'intero giro, lock senza heartbeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NoteStore } from '../../../src/notes/store.ts';
import type { Note } from '../../../src/notes/store.ts';
import { publishOne, runDue } from '../../../src/notes/publish.ts';
import { StateError } from '../../../src/util/errors.ts';
import { withLock } from '../../../src/util/fs.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const T0 = new Date('2026-10-08T10:00:00Z');
const NOW = new Date('2026-10-08T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

async function scheduled(store: NoteStore, text: string, when: Date): Promise<Note> {
  const n = await store.add(text, T0);
  return store.schedule(n.id, when, T0);
}

test('runDue: una nota tolta dalla schedulazione durante il giro non viene pubblicata', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await scheduled(store, 'a', at(10));
    const b = await scheduled(store, 'b', at(20));
    const posted: string[] = [];
    const r = await runDue(store, async (doc) => {
      posted.push(JSON.stringify(doc));
      if (posted.length === 1) await store.unschedule(b.id); // l'utente la toglie mentre si pubblica A
      return { id: `s${posted.length}` };
    }, NOW);
    assert.equal(posted.length, 1);
    assert.deepEqual(r.published, [a.id]);
    assert.equal((await store.get(b.id)).status, 'draft');
  });
});

test('runDue: una nota rimandata al futuro durante il giro non viene pubblicata', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await scheduled(store, 'a', at(10));
    const b = await scheduled(store, 'b', at(20));
    let calls = 0;
    const r = await runDue(store, async () => {
      calls++;
      await store.schedule(b.id, new Date('2026-10-09T12:00:00Z'), T0);
      return { id: 'x' };
    }, NOW);
    assert.equal(calls, 1);
    assert.deepEqual(r.published, [a.id]);
    const fresh = await store.get(b.id);
    assert.equal(fresh.status, 'scheduled');
    assert.equal(fresh.publishAt, '2026-10-09T12:00:00.000Z');
  });
});

test('runDue: una nota riportata in draft durante il giro non viene pubblicata come draft', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'a', at(10));
    const b = await scheduled(store, 'b', at(20));
    let calls = 0;
    await runDue(store, async () => {
      calls++;
      await store.unschedule(b.id);
      return { id: 'x' };
    }, NOW);
    assert.equal(calls, 1);
    assert.equal((await store.get(b.id)).status, 'draft');
  });
});

/** Store la cui scrittura si ferma su un cancello: simula un processo lento tra lettura e scrittura. */
class GatedStore extends NoteStore {
  gate: Promise<void> = Promise.resolve();
  reached: () => void = () => undefined;
  protected override async write(note: Note): Promise<Note> {
    this.reached();
    await this.gate;
    return super.write(note);
  }
}

test('aggiornamento perso: un unschedule lento sotto lock blocca run-due (nessuna pubblicazione)', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const b = await scheduled(store, 'b', at(10));
    const slow = new GatedStore(dir);
    let open!: () => void;
    slow.gate = new Promise<void>((r) => { open = r; });
    const reached = new Promise<void>((r) => { slow.reached = r; });
    const stale = slow.locked(() => slow.unschedule(b.id));
    await reached; // ha letto "scheduled" e sta per scrivere "draft", tenendo il lock
    let calls = 0;
    await assert.rejects(runDue(store, async () => { calls++; return { id: 'x' }; }, NOW), StateError);
    open();
    assert.equal((await stale).status, 'draft');
    assert.equal(calls, 0);
  });
});

test('aggiornamento perso: durante run-due un unschedule della CLI fallisce, la nota resta published', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const other = new NoteStore(dir);
    const b = await scheduled(store, 'b', at(10));
    let calls = 0;
    let staleErr: unknown;
    const r = await runDue(store, async () => {
      calls++;
      // Un secondo processo (note unschedule) prova a scrivere mentre la nota è in publishing.
      staleErr = await other.locked(() => other.unschedule(b.id)).then(() => undefined, (e: unknown) => e);
      return { id: 'x' };
    }, NOW);
    assert.ok(staleErr instanceof StateError);
    assert.deepEqual(r.published, [b.id]);
    assert.equal((await store.get(b.id)).status, 'published');
    // Un secondo giro non ripubblica.
    await runDue(store, async () => { calls++; return { id: 'y' }; }, NOW);
    assert.equal(calls, 1);
  });
});

test('le operazioni locked della CLI usano il lock della coda', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', T0);
    await withLock(store.lockPath, async () => {
      await assert.rejects(store.locked(() => store.schedule(n.id, at(10), T0)), /in corso/);
    });
    assert.equal((await store.locked(() => store.schedule(n.id, at(10), T0))).status, 'scheduled');
  });
});

test('runDue: nota sparita o corrotta durante il giro non ferma le altre; il risultato resta completo', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await scheduled(store, 'a', at(10));
    const b = await scheduled(store, 'b', at(20));
    const c = await scheduled(store, 'c', at(30));
    const d = await scheduled(store, 'd', at(40));
    let calls = 0;
    const r = await runDue(store, async () => {
      if (++calls === 1) {
        await rm(join(dir, `${b.id}.json`));
        await writeFile(join(dir, `${c.id}.json`), '{rotto');
      }
      return { id: `s${calls}` };
    }, NOW);
    assert.equal(calls, 2);
    assert.deepEqual(r.published, [a.id, d.id]);
    assert.deepEqual(r.failed.map((x) => x.id), [b.id]);
    assert.match(r.failed[0]!.error, /non trovata/);
    assert.deepEqual(r.corrupt, [`${c.id}.json`]);
  });
});

test('publishOne: se la pubblicazione riesce ma lo stato locale non si aggiorna, esito incerto (non "failed")', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', T0);
    const out = await publishOne(store, n.id, async () => {
      await rm(join(dir, `${n.id}.json`));
      return { id: 'sub-1' };
    }, NOW, ['draft']);
    assert.equal(out.kind, 'uncertain');
    if (out.kind === 'uncertain') assert.match(out.error.message, /sub-1/);
  });
});

test('publishOne con from esplicito: run-due accetta solo "scheduled"', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', T0);
    let calls = 0;
    await assert.rejects(publishOne(store, n.id, async () => { calls++; return { id: 'x' }; }, NOW, ['scheduled']), StateError);
    assert.equal(calls, 0);
    assert.equal((await store.get(n.id)).status, 'draft');
  });
});

test('heartbeat: run-due rinnova il lock prima di ogni nota', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'a', at(10));
    await scheduled(store, 'b', at(20));
    let calls = 0;
    let competitor: unknown;
    const r = await runDue(store, async () => {
      if (++calls === 1) {
        const old = new Date(Date.now() - 3_600_000);
        await utimes(store.lockPath, old, old); // il lock sembra vecchio di un'ora...
      } else {
        // ...ma prima della seconda nota è stato rinnovato: nessuno può prenderlo in carico.
        assert.ok(Date.now() - (await stat(store.lockPath)).mtimeMs < 60_000);
        competitor = await withLock(store.lockPath, async () => 'preso', 60_000).catch((e: unknown) => e);
      }
      return { id: `s${calls}` };
    }, NOW, { staleMs: 60_000 });
    assert.equal(r.published.length, 2);
    assert.ok(competitor instanceof StateError);
  });
});

test('heartbeat: se il lock è stato preso da un altro processo, run-due si interrompe prima della nota successiva', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await scheduled(store, 'a', at(10));
    const b = await scheduled(store, 'b', at(20));
    let calls = 0;
    await assert.rejects(runDue(store, async () => {
      calls++;
      const old = new Date(Date.now() - 3_600_000);
      await utimes(store.lockPath, old, old);
      // Un altro processo considera il lock scaduto e lo prende (tenendolo).
      await writeFile(store.lockPath, 'altro-processo');
      return { id: 'x' };
    }, NOW, { staleMs: 60_000 }), (e: unknown) => e instanceof StateError && /lock/i.test(e.message) && e.message.includes(a.id));
    assert.equal(calls, 1);
    assert.equal((await store.get(a.id)).status, 'published');
    assert.equal((await store.get(b.id)).status, 'scheduled');
    assert.equal(await readFile(store.lockPath, 'utf8'), 'altro-processo'); // non rilasciato: non è nostro
  });
});
