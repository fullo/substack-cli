import { join } from 'node:path';
import { configDir, loadConfig, validateConfig } from '../../config/config.ts';
import { UsageError } from '../../util/errors.ts';
import { t } from '../../util/i18n.ts';
import { atomicWriteFile, readTextIfExists } from '../../util/fs.ts';
import { emit, flag, str } from '../shared.ts';
import type { Command } from '../shared.ts';

export const configCommands: Command[] = [
  {
    path: 'config init',
    summary: {
      en: 'Create config.json (--publication <subdomain> [--lang en|it] [--provider ...] [--model ...] [--llm-base-url ...] [--force])',
      it: 'Crea config.json (--publication <subdomain> [--lang en|it] [--provider ...] [--model ...] [--llm-base-url ...] [--force])',
    },
    options: {
      publication: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
      'llm-base-url': { type: 'string' }, lang: { type: 'string' }, force: { type: 'boolean' },
    },
    async run(ctx, { values }) {
      const publication = str(values, 'publication');
      if (!publication) {
        throw new UsageError(t('--publication <subdomain> is required (the part before .substack.com)',
          'Serve --publication <subdomain> (la parte prima di .substack.com)'));
      }
      const lang = str(values, 'lang');
      const generate: Record<string, string> = {};
      const provider = str(values, 'provider');
      if (provider) generate.provider = provider;
      const model = str(values, 'model');
      if (model) generate.model = model;
      const baseUrl = str(values, 'llm-base-url');
      if (baseUrl) generate.baseUrl = baseUrl;
      const path = join(configDir(ctx.env), 'config.json');
      if ((await readTextIfExists(path)) !== undefined && !flag(values, 'force')) {
        throw new UsageError(t(`${path} already exists (use --force to overwrite)`, `${path} esiste già (usa --force per sovrascrivere)`));
      }
      const candidate: Record<string, unknown> = { publication };
      if (lang !== undefined) candidate.lang = lang;
      if (Object.keys(generate).length) candidate.generate = generate;
      // Valida il contenuto stesso PRIMA di scrivere: rileggere il file con loadConfig non basta,
      // perché SUBSTACK_PUBLICATION/SUBSTACK_BASE_URL/SUBSTACK_CLI_CONFIG mascherano i valori scritti,
      // e rimuovere il file dopo un fallimento distruggerebbe la config esistente (--force).
      validateConfig(candidate);
      await atomicWriteFile(path, JSON.stringify(candidate, null, 2) + '\n', 0o644);
      emit(ctx, values, { path }, t(`Configuration written to ${path}`, `Configurazione scritta in ${path}`));
      return 0;
    },
  },
  {
    path: 'config show',
    summary: { en: 'Show the effective configuration (contains no secrets)', it: 'Mostra la configurazione effettiva (non contiene segreti)' },
    options: {},
    async run(ctx, { values }) {
      const config = await loadConfig(ctx.env);
      emit(ctx, values, config, JSON.stringify(config, null, 2));
      return 0;
    },
  },
];
