import { parseArgs } from 'node:util';
import { testClockNow } from '../util/clock.ts';
import { CliError, UsageError } from '../util/errors.ts';
import { redact } from '../util/redact.ts';
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
  const lines = COMMANDS.map((c) => `  substack ${c.path.padEnd(width)}  ${c.summary}`);
  return ['Uso: substack <gruppo> <comando> [opzioni]', '', ...lines, '', 'Opzione comune: --json (output per macchine)'].join('\n');
}

function reportError(e: unknown, ctx: Ctx): number {
  if (e instanceof CliError) {
    ctx.err(`Errore: ${redact(e.message)}`);
    return e.exitCode;
  }
  const msg = e instanceof Error ? e.message : String(e);
  ctx.err(`Errore interno: ${redact(msg)}`);
  if (ctx.env.SUBSTACK_DEBUG === '1' && e instanceof Error && e.stack) ctx.err(redact(e.stack));
  return 1;
}

export async function run(argv: string[], ctx: Ctx): Promise<number> {
  // L'orologio di test cambia cosa run-due considera scaduto: se attivo deve essere sempre visibile.
  const fake = testClockNow(ctx.env);
  if (fake) ctx.err(`Attenzione: orologio di test attivo (SUBSTACK_NOW=${fake.toISOString()}): non usarlo in produzione`);
  try {
    const [group, sub, ...rest] = argv;
    if (group === undefined || group === 'help' || group === '--help' || group === '-h') {
      ctx.out(helpText());
      return 0;
    }
    const cmd = COMMANDS.find((c) => c.path === `${group} ${sub}`);
    if (!cmd) {
      throw new UsageError(`Comando sconosciuto: "${[group, sub].filter(Boolean).join(' ')}". Usa "substack help".`);
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
