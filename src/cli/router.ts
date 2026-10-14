import { parseArgs } from 'node:util';
import { testClockNow } from '../util/clock.ts';
import { CliError, UsageError } from '../util/errors.ts';
import { redact } from '../util/redact.ts';
import { isLang, setLang, t } from '../util/i18n.ts';
import type { Lang } from '../util/i18n.ts';
import { loadConfig } from '../config/config.ts';
import { articleCommands } from './commands/article.ts';
import { authCommands } from './commands/auth.ts';
import { configCommands } from './commands/config.ts';
import { generateCommands } from './commands/generate.ts';
import { noteCommands } from './commands/note.ts';
import type { Ctx } from './context.ts';
import type { Command, Values } from './shared.ts';

const COMMANDS: Command[] = [
  ...authCommands, ...articleCommands, ...noteCommands, ...generateCommands, ...configCommands,
];

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.path.length));
  const lines = COMMANDS.map((c) => `  substack ${c.path.padEnd(width)}  ${t(c.summary.en, c.summary.it)}`);
  return [
    t('Usage: substack <group> <command> [options]', 'Uso: substack <gruppo> <comando> [opzioni]'),
    '', ...lines, '',
    t('Common option: --json (machine-readable output)', 'Opzione comune: --json (output per macchine)'),
    t('Language: English by default; Italian with SUBSTACK_LANG=it or "lang": "it" in config.json',
      'Lingua: inglese di default; italiano con SUBSTACK_LANG=it oppure "lang": "it" in config.json'),
  ].join('\n');
}

function reportError(e: unknown, ctx: Ctx): number {
  if (e instanceof CliError) {
    ctx.err(`${t('Error', 'Errore')}: ${redact(e.message)}`);
    return e.exitCode;
  }
  const msg = e instanceof Error ? e.message : String(e);
  ctx.err(`${t('Internal error', 'Errore interno')}: ${redact(msg)}`);
  if (ctx.env.SUBSTACK_DEBUG === '1' && e instanceof Error && e.stack) ctx.err(redact(e.stack));
  return 1;
}

/**
 * Lingua dei messaggi: SUBSTACK_LANG ha la precedenza su "lang" in config.json; default inglese.
 * Una configurazione illeggibile non blocca la scelta: l'errore lo segnalerà il comando, in inglese.
 */
async function resolveLang(env: NodeJS.ProcessEnv): Promise<{ lang: Lang; invalidEnv?: string }> {
  const fromEnv = env.SUBSTACK_LANG?.trim().toLowerCase();
  if (fromEnv) {
    // Accetta anche forme come "it_IT.UTF-8" o "en-GB".
    const short = fromEnv.slice(0, 2);
    if (isLang(short)) return { lang: short };
    return { lang: 'en', invalidEnv: env.SUBSTACK_LANG };
  }
  try {
    const config = await loadConfig(env);
    if (config.lang) return { lang: config.lang };
  } catch { /* configurazione non valida: la segnala il comando che la usa */ }
  return { lang: 'en' };
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  setLang('en');
  const { lang, invalidEnv } = await resolveLang(ctx.env);
  setLang(lang);
  if (invalidEnv !== undefined) ctx.err(`Warning: SUBSTACK_LANG="${invalidEnv}" is not supported (use en or it): using English`);
  // L'orologio di test cambia cosa run-due considera scaduto: se attivo deve essere sempre visibile.
  const fake = testClockNow(ctx.env);
  if (fake) {
    ctx.err(t(`Warning: test clock active (SUBSTACK_NOW=${fake.toISOString()}): do not use it in production`,
      `Attenzione: orologio di test attivo (SUBSTACK_NOW=${fake.toISOString()}): non usarlo in produzione`));
  }
  try {
    const [group, sub, ...rest] = argv;
    if (group === undefined || group === 'help' || group === '--help' || group === '-h') {
      ctx.out(helpText());
      return 0;
    }
    const cmd = COMMANDS.find((c) => c.path === `${group} ${sub}`);
    if (!cmd) {
      const name = [group, sub].filter(Boolean).join(' ');
      throw new UsageError(t(`Unknown command: "${name}". Use "substack help".`, `Comando sconosciuto: "${name}". Usa "substack help".`));
    }
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        options: { json: { type: 'boolean' }, ...cmd.options },
        allowPositionals: true,
        strict: true,
      });
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    return await cmd.run(ctx, { values: parsed.values as Values, positionals: parsed.positionals });
  } catch (e) {
    return reportError(e, ctx);
  }
}
