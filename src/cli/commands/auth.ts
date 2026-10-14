import { authGuide } from '../../auth/guide.ts';
import { browserLogin } from '../../auth/login.ts';
import { normalizeSid, saveSecret, secretsPermissionWarning } from '../../auth/store.ts';
import { registerSecret } from '../../util/redact.ts';
import { UsageError } from '../../util/errors.ts';
import { t } from '../../util/i18n.ts';
import type { Ctx } from '../context.ts';
import { emit, flag, makeClient } from '../shared.ts';
import type { Command, Values } from '../shared.ts';

async function check(ctx: Ctx, values: Values): Promise<number> {
  const client = await makeClient(ctx);
  const profile = await client.getProfile();
  const warning = await secretsPermissionWarning(ctx.env);
  if (warning) ctx.err(`${t('Warning', 'Attenzione')}: ${warning}`);
  const who = profile.handle ? `${profile.name ?? ''} (@${profile.handle})`.trim() : (profile.name ?? t(`user ${profile.id}`, `utente ${profile.id}`));
  emit(ctx, values, { valid: true, id: profile.id, name: profile.name ?? null, handle: profile.handle ?? null },
    t(`Valid session: ${who}`, `Sessione valida: ${who}`));
  return 0;
}

export const authCommands: Command[] = [
  {
    path: 'auth guide',
    summary: { en: 'Step-by-step tutorial to get the session cookie', it: 'Tutorial passo passo per ottenere il cookie di sessione' },
    options: {},
    async run(ctx) {
      ctx.out(authGuide());
      return 0;
    },
  },
  {
    path: 'auth set',
    summary: { en: 'Save the substack.sid cookie (hidden prompt or stdin) and check it', it: 'Salva il cookie substack.sid (prompt nascosto o stdin) e lo verifica' },
    options: { 'no-check': { type: 'boolean' } },
    async run(ctx, { values }) {
      // Con stdin da terminale il cookie va sempre chiesto con il prompt nascosto: leggerlo "da stdin"
      // lo farebbe comparire a schermo mentre lo si incolla (anche con stdout rediretto).
      const raw = ctx.stdinIsTTY ? await ctx.prompt(t('Paste the substack.sid value (it will not be shown): ', 'Incolla il valore di substack.sid (non verrà mostrato): '), { hidden: true }) : await ctx.readStdin();
      if (raw.trim() === '') throw new UsageError(t('No value received. See "substack auth guide".', 'Nessun valore ricevuto. Vedi "substack auth guide".'));
      const sid = normalizeSid(raw);
      registerSecret(sid);
      await saveSecret(ctx.env, { sid });
      ctx.err(t('Cookie saved.', 'Cookie salvato.'));
      return flag(values, 'no-check') ? 0 : check(ctx, values);
    },
  },
  {
    path: 'auth check',
    summary: { en: 'Check that the session is valid (exit 2 if expired)', it: 'Verifica che la sessione sia valida (exit 2 se scaduta)' },
    options: {},
    async run(ctx, { values }) {
      return check(ctx, values);
    },
  },
  {
    path: 'auth login',
    summary: { en: 'Sign in through a browser (Playwright, optional) and save the cookie', it: 'Login via browser (Playwright, opzionale) e salvataggio del cookie' },
    options: { print: { type: 'boolean' } },
    async run(ctx, { values }) {
      const sid = normalizeSid(await browserLogin());
      registerSecret(sid);
      await saveSecret(ctx.env, { sid });
      ctx.err(t('Signed in: cookie saved.', 'Login riuscito: cookie salvato.'));
      // `--print` stampa volutamente il cookie per copiarlo sulla VM: ctx.out lo redigerebbe,
      // quindi questo è l'unico punto in cui il cookie esce, e solo su richiesta esplicita.
      if (flag(values, 'print')) process.stdout.write(sid + '\n');
      return 0;
    },
  },
];
