// Limite di dimensione sul corpo letto in streaming (red team: risposta chunked senza content-length).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubstackClient } from '../../../src/substack/client.ts';
import { ApiShapeError } from '../../../src/util/errors.ts';
import { makeFetch } from '../../helpers/fetch.ts';

const SID = 's%3AabcdefGHIJKLmnop1234567890.signature';

function client(make: () => Response) {
  return new SubstackClient({
    sid: SID, publicationUrl: 'https://pub.example', globalUrl: 'https://glob.example', maxAttempts: 1,
    fetchImpl: makeFetch(make),
  });
}

const tooBig = (e: Error) => e instanceof ApiShapeError && e.message === 'Risposta troppo grande su /api/v1/user/profile/self' &&
  (e as ApiShapeError).httpStatus === 200;

test('corpo in streaming senza fine: si smette di leggere appena superati i 5 MB e lo stream viene annullato', async () => {
  let pulled = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1_000_000).fill(0x61);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulled++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(client(() => new Response(body, { status: 200 })).getProfile(), tooBig);
  assert.ok(pulled <= 7, `chunk letti: ${pulled}`);
  assert.equal(cancelled, true);
});

test('corpo in streaming a più chunk: esattamente 5 MB accettati, un byte in più no', async () => {
  const exact = JSON.stringify({ id: 1, pad: '' });
  const padded = JSON.stringify({ id: 7, pad: 'x'.repeat(5_000_000 - exact.length) });
  const streamOf = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    let pos = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pos >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(pos, pos + 700_000));
        pos += 700_000;
      },
    });
  };
  assert.equal((await client(() => new Response(streamOf(padded), { status: 200 })).getProfile()).id, 7);
  await assert.rejects(client(() => new Response(streamOf(padded + ' '), { status: 200 })).getProfile(), tooBig);
  // Testo multibyte spezzato a metà carattere tra due chunk: decodificato correttamente.
  const name = 'è'.repeat(1_000_001);
  assert.equal((await client(() => new Response(streamOf(JSON.stringify({ id: 1, name })), { status: 200 })).getProfile()).name, name);
});

test('risposte senza stream (solo text()): stesso limite, in byte UTF-8', async () => {
  const fake = (text: string) =>
    ({ status: 200, headers: new Headers(), body: null, text: async () => text }) as unknown as Response;
  const exact = JSON.stringify({ id: 1, pad: '' });
  const padded = JSON.stringify({ id: 3, pad: 'x'.repeat(5_000_000 - exact.length) });
  assert.equal((await client(() => fake(padded)).getProfile()).id, 3);
  await assert.rejects(client(() => fake(padded + ' ')).getProfile(), tooBig);
  // 2 500 001 caratteri ma 5 000 002 byte: conta la dimensione in byte.
  await assert.rejects(client(() => fake('è'.repeat(2_500_001))).getProfile(), tooBig);
});
