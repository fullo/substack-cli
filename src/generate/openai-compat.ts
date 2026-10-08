import { z } from 'zod';
import { ProviderError } from '../util/errors.ts';
import type { GenerateRequest, Provider } from './provider.ts';

const ResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }).passthrough() }).passthrough()).min(1),
}).passthrough();

export interface OpenAiCompatOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export function openaiCompatProvider(opts: OpenAiCompatOptions): Provider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async generate(req: GenerateRequest): Promise<string> {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(opts.timeoutMs),
          headers,
          body: JSON.stringify({
            model: opts.model,
            max_tokens: req.maxTokens,
            messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }],
          }),
        });
      } catch (e) {
        throw new ProviderError(`Chiamata al server LLM fallita: ${(e as Error).message}`);
      }
      if (!res.ok) throw new ProviderError(`Il server LLM ha risposto con stato ${res.status}`);
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new ProviderError('Risposta del server LLM non JSON');
      }
      const parsed = ResponseSchema.safeParse(data);
      const text = parsed.success ? (parsed.data.choices[0]?.message.content ?? '') : '';
      if (!text) throw new ProviderError('Risposta del server LLM senza testo');
      return text;
    },
  };
}
