import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir, loadConfig } from '../../config/config.ts';
import { UsageError } from '../../util/errors.ts';
import { atomicWriteFile, readTextIfExists } from '../../util/fs.ts';
import { emit, flag, str } from '../shared.ts';
import type { Command } from '../shared.ts';

export const configCommands: Command[] = [
  {
    path: 'config init',
    summary: 'Crea config.json (--publication <subdomain> [--provider ...] [--model ...] [--llm-base-url ...] [--force])',
    options: {
      publication: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
      'llm-base-url': { type: 'string' }, force: { type: 'boolean' },
    },
    async run(ctx, { values }) {
      const publication = str(values, 'publication');
      if (!publication) throw new UsageError('Serve --publication <subdomain> (la parte prima di .substack.com)');
      const generate: Record<string, string> = {};
      const provider = str(values, 'provider');
      if (provider) generate.provider = provider;
      const model = str(values, 'model');
      if (model) generate.model = model;
      const baseUrl = str(values, 'llm-base-url');
      if (baseUrl) generate.baseUrl = baseUrl;
      const path = join(configDir(ctx.env), 'config.json');
      if ((await readTextIfExists(path)) !== undefined && !flag(values, 'force')) {
        throw new UsageError(`${path} esiste già (usa --force per sovrascrivere)`);
      }
      const candidate = Object.keys(generate).length ? { publication, generate } : { publication };
      // Scrive, poi rilegge con lo stesso schema usato a runtime; se non valida, rimuove il file.
      await atomicWriteFile(path, JSON.stringify(candidate, null, 2) + '\n', 0o644);
      try {
        await loadConfig(ctx.env);
      } catch (e) {
        await rm(path, { force: true });
        throw e;
      }
      emit(ctx, values, { path }, `Configurazione scritta in ${path}`);
      return 0;
    },
  },
  {
    path: 'config show',
    summary: 'Mostra la configurazione effettiva (non contiene segreti)',
    options: {},
    async run(ctx, { values }) {
      const config = await loadConfig(ctx.env);
      emit(ctx, values, config, JSON.stringify(config, null, 2));
      return 0;
    },
  },
];
