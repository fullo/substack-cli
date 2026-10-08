import { AUTH_GUIDE } from '../../auth/guide.ts';
import { browserLogin } from '../../auth/login.ts';
import { normalizeSid, saveSecret, secretsPermissionWarning } from '../../auth/store.ts';
import { registerSecret } from '../../util/redact.ts';
import { UsageError } from '../../util/errors.ts';
import type { Ctx } from '../context.ts';
import { emit, flag, makeClient } from '../shared.ts';
import type { Command, Values } from '../shared.ts';

async function check(ctx: Ctx, values: Values): Promise<number> {
  const client = await makeClient(ctx);
  const profile = await client.getProfile();
  const warning = await secretsPermissionWarning(ctx.env);
  if (warning) ctx.err(`Attenzione: ${warning}`);
  const who = profile.handle ? `${profile.name ?? ''} (@${profile.handle})`.trim() : (profile.name ?? `utente ${profile.id}`);
  emit(ctx, values, { valid: true, id: profile.id, name: profile.name ?? null, handle: profile.handle ?? null },
    `Sessione valida: ${who}`);
  return 0;
}

export const authCommands: Command[] = [
  {
    path: 'auth guide',
    summary: 'Tutorial passo passo per ottenere il cookie di sessione',
    options: {},
    async run(ctx) {
      ctx.out(AUTH_GUIDE);
      return 0;
    },
  },
  {
    path: 'auth set',
    summary: 'Salva il cookie substack.sid (prompt nascosto o stdin) e lo verifica',
    options: { 'no-check': { type: 'boolean' } },
    async run(ctx, { values }) {
      // Con stdin da terminale il cookie va sempre chiesto con il prompt nascosto: leggerlo "da stdin"
      // lo farebbe comparire a schermo mentre lo si incolla (anche con stdout rediretto).
      const raw = ctx.stdinIsTTY ? await ctx.prompt('Incolla il valore di substack.sid (non verrà mostrato): ', { hidden: true }) : await ctx.readStdin();
      if (raw.trim() === '') throw new UsageError('Nessun valore ricevuto. Vedi "substack auth guide".');
      const sid = normalizeSid(raw);
      registerSecret(sid);
      await saveSecret(ctx.env, { sid });
      ctx.err('Cookie salvato.');
      return flag(values, 'no-check') ? 0 : check(ctx, values);
    },
  },
  {
    path: 'auth check',
    summary: 'Verifica che la sessione sia valida (exit 2 se scaduta)',
    options: {},
    async run(ctx, { values }) {
      return check(ctx, values);
    },
  },
  {
    path: 'auth login',
    summary: 'Login via browser (Playwright, opzionale) e salvataggio del cookie',
    options: { print: { type: 'boolean' } },
    async run(ctx, { values }) {
      const sid = normalizeSid(await browserLogin());
      registerSecret(sid);
      await saveSecret(ctx.env, { sid });
      ctx.err('Login riuscito: cookie salvato.');
      // `--print` stampa volutamente il cookie per copiarlo sulla VM: ctx.out lo redigerebbe,
      // quindi questo è l'unico punto in cui il cookie esce, e solo su richiesta esplicita.
      if (flag(values, 'print')) process.stdout.write(sid + '\n');
      return 0;
    },
  },
];
