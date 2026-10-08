import { z } from 'zod';
import { ProviderError } from '../util/errors.ts';
import { readBodyLimited } from '../util/http.ts';
import type { GenerateRequest, Provider } from './provider.ts';

const ResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).min(1),
}).passthrough();

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function anthropicProvider(opts: AnthropicOptions): Provider {
  const base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async generate(req: GenerateRequest): Promise<string> {
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/messages`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(opts.timeoutMs),
          headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: [{ role: 'user', content: req.prompt }],
          }),
        });
      } catch (e) {
        throw new ProviderError(`Chiamata ad Anthropic fallita: ${(e as Error).message}`);
      }
      if (!res.ok) throw new ProviderError(`Anthropic ha risposto con stato ${res.status}`);
      const body = await readBodyLimited(res);
      if (!body.ok && body.reason === 'too-large') throw new ProviderError('Risposta di Anthropic troppo grande (max 5 MB)');
      if (!body.ok) throw new ProviderError(`Lettura della risposta di Anthropic interrotta: ${body.error.message}`);
      let data: unknown;
      try {
        data = JSON.parse(body.text);
      } catch {
        throw new ProviderError('Risposta di Anthropic non JSON');
      }
      const parsed = ResponseSchema.safeParse(data);
      const text = parsed.success ? parsed.data.content.map((c) => c.text ?? '').join('') : '';
      if (!text) throw new ProviderError('Risposta di Anthropic senza testo');
      return text;
    },
  };
}
