// ENDPOINT CANDIDATI — da confermare nella Fase 0 (tests/fixtures/README.md)
//   globalUrl:      GET  /api/v1/user/profile/self
//                   POST /api/v1/comment/feed
//   publicationUrl: POST /api/v1/drafts
//                   GET  /api/v1/drafts/{id}
//                   GET  /api/v1/post_management/drafts?offset&limit&order_by&order_direction
//                   POST /api/v1/drafts/{id}/publish
//                   POST /api/v1/drafts/{id}/scheduled_release
import type { z } from 'zod';
import type { PMDoc } from '../markdown/prosemirror.ts';
import { ApiShapeError, AuthError, NetworkError, RateLimitError, UsageError } from '../util/errors.ts';
import { readBodyLimited } from '../util/http.ts';
import { AnySchema, DraftCreatedSchema, DraftListSchema, DraftSchema, NoteCreatedSchema, ProfileSchema } from './schemas.ts';
import type { Draft, Profile } from './schemas.ts';

const USER_AGENT = 'substack-cli/0.1 (+https://github.com/local/substack-cli)';

export interface ClientOptions {
  sid: string;
  publicationUrl: string;
  globalUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface RequestInitLite { method: 'GET' | 'POST'; body?: unknown }

export function parseDraftId(value: string | undefined): number {
  if (value === undefined || !/^[1-9][0-9]{0,14}$/.test(value)) {
    throw new UsageError(`Id bozza non valido: "${value ?? ''}" (atteso un intero positivo)`);
  }
  return Number(value);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const when = Date.parse(header);
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

export class SubstackClient {
  private readonly sid: string;
  private readonly publicationUrl: string;
  private readonly globalUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: ClientOptions) {
    this.sid = opts.sid;
    this.publicationUrl = opts.publicationUrl;
    this.globalUrl = opts.globalUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Rimuove il cookie (anche decodificato) da testi di errore di terze parti. */
  private scrub(text: string): string {
    let out = text;
    const forms = new Set([this.sid]);
    try { forms.add(decodeURIComponent(this.sid)); } catch { /* sid non decodificabile */ }
    for (const f of forms) if (f.length > 0) out = out.split(f).join('[REDACTED]');
    return out;
  }

  private async once<S extends z.ZodTypeAny>(url: string, path: string, init: RequestInitLite, schema: S): Promise<z.infer<S>> {
    const headers: Record<string, string> = {
      cookie: `substack.sid=${this.sid}`,
      'user-agent': USER_AGENT,
      accept: 'application/json',
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: init.method,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (e) {
      const host = new URL(url).host;
      throw new NetworkError(`Richiesta a ${host}${path} fallita: ${this.scrub(e instanceof Error ? e.message : String(e))}`);
    }

    if (res.status >= 300 && res.status < 400) {
      throw new NetworkError(`Redirect inatteso (${res.status}) su ${path}: non seguito per sicurezza`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`Accesso negato (${res.status}) su ${path}: il cookie è scaduto o non valido. Esegui "substack auth guide".`);
    }
    if (res.status === 429) {
      throw new RateLimitError(`Troppe richieste (429) su ${path}`, parseRetryAfter(res.headers.get('retry-after')));
    }
    if (res.status >= 500) throw new NetworkError(`Errore del server (${res.status}) su ${path}`);
    if (res.status < 200 || res.status >= 300) {
      throw new ApiShapeError(`Stato HTTP inatteso ${res.status} su ${path}`, res.status);
    }

    const body = await readBodyLimited(res);
    if (!body.ok && body.reason === 'too-large') throw new ApiShapeError(`Risposta troppo grande su ${path}`, res.status);
    if (!body.ok) {
      // Timeout o connessione chiusa durante la lettura: errore di rete (riprovato se la richiesta è idempotente).
      throw new NetworkError(`Lettura della risposta da ${new URL(url).host}${path} interrotta: ${this.scrub(body.error.message)}`);
    }
    const text = body.text;

    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new ApiShapeError(`Risposta non JSON su ${path}`, res.status);
      }
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`).join('; ');
      throw new ApiShapeError(`Risposta inattesa su ${path} (l'API di Substack potrebbe essere cambiata): ${issues}`, res.status);
    }
    return parsed.data;
  }

  private async request<S extends z.ZodTypeAny>(
    base: string, path: string, init: RequestInitLite, schema: S, idempotent: boolean,
  ): Promise<z.infer<S>> {
    const attempts = idempotent ? this.maxAttempts : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(`${base}${path}`, path, init, schema);
      } catch (e) {
        const retriable = e instanceof NetworkError || e instanceof RateLimitError;
        if (!retriable || attempt >= attempts) throw e;
        const wait = e instanceof RateLimitError && e.retryAfterMs !== undefined
          ? Math.min(e.retryAfterMs, 30_000)
          : 500 * 2 ** (attempt - 1);
        await this.sleep(wait);
      }
    }
  }

  getProfile(): Promise<Profile> {
    return this.request(this.globalUrl, '/api/v1/user/profile/self', { method: 'GET' }, ProfileSchema, true);
  }

  async createDraft(input: { title: string; subtitle?: string; body: PMDoc; authorId: number }): Promise<{ id: number; url: string }> {
    const r = await this.request(this.publicationUrl, '/api/v1/drafts', {
      method: 'POST',
      body: {
        draft_title: input.title,
        draft_subtitle: input.subtitle ?? '',
        draft_body: JSON.stringify(input.body),
        type: 'newsletter',
        audience: 'everyone',
        draft_bylines: [{ id: input.authorId, is_guest: false }],
      },
    }, DraftCreatedSchema, false);
    return { id: r.id, url: `${this.publicationUrl}/publish/post/${r.id}` };
  }

  getDraft(id: number): Promise<Draft> {
    return this.request(this.publicationUrl, `/api/v1/drafts/${id}`, { method: 'GET' }, DraftSchema, true);
  }

  async listDrafts(limit = 25): Promise<Draft[]> {
    const q = `offset=0&limit=${limit}&order_by=draft_updated_at&order_direction=desc`;
    const r = await this.request(this.publicationUrl, `/api/v1/post_management/drafts?${q}`, { method: 'GET' }, DraftListSchema, true);
    return r.posts;
  }

  async publishDraft(id: number, opts: { sendEmail: boolean }): Promise<void> {
    await this.request(this.publicationUrl, `/api/v1/drafts/${id}/publish`, {
      method: 'POST',
      body: { send: opts.sendEmail, share_automatically: false },
    }, AnySchema, false);
  }

  async scheduleDraft(id: number, at: Date, opts: { sendEmail: boolean }): Promise<void> {
    await this.request(this.publicationUrl, `/api/v1/drafts/${id}/scheduled_release`, {
      method: 'POST',
      body: {
        trigger_at: at.toISOString(),
        post_audience: 'everyone',
        email_audience: opts.sendEmail ? 'everyone' : 'no_one',
      },
    }, AnySchema, false);
  }

  async cancelSchedule(id: number): Promise<void> {
    await this.request(this.publicationUrl, `/api/v1/drafts/${id}/scheduled_release`, {
      method: 'POST',
      body: { trigger_at: null },
    }, AnySchema, true);
  }

  async postNote(doc: PMDoc): Promise<{ id: string }> {
    const r = await this.request(this.globalUrl, '/api/v1/comment/feed', {
      method: 'POST',
      body: { bodyJson: doc, tabId: 'for-you', surface: 'feed', replyMinimumRole: 'everyone' },
    }, NoteCreatedSchema, false);
    return { id: String(r.id) };
  }
}
