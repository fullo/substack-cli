/** Dimensione massima del corpo di una risposta (Substack e provider LLM). */
export const MAX_RESPONSE_BYTES = 5_000_000;

export type BodyResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too-large' }
  | { ok: false; reason: 'interrupted'; error: Error };

/**
 * Legge il corpo come testo fermandosi oltre `limit` byte. Senza content-length (risposta chunked)
 * res.text()/res.json() leggerebbero in memoria un corpo arbitrariamente grande prima di qualsiasi
 * controllo; qui il trasferimento viene annullato appena il limite è superato. Un content-length
 * dichiarato oltre il limite viene rifiutato senza leggere nulla. Un errore durante la lettura
 * (timeout, connessione chiusa) diventa `interrupted`: il chiamante lo mappa sul proprio errore tipizzato.
 */
export async function readBodyLimited(res: Response, limit = MAX_RESPONSE_BYTES): Promise<BodyResult> {
  if (Number(res.headers.get('content-length') ?? '0') > limit) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'too-large' };
  }
  try {
    if (!res.body) {
      const text = await res.text();
      return Buffer.byteLength(text, 'utf8') > limit ? { ok: false, reason: 'too-large' } : { ok: true, text };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(value);
    }
    return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
  } catch (e) {
    return { ok: false, reason: 'interrupted', error: e instanceof Error ? e : new Error(String(e)) };
  }
}
