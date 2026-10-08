// Uso: SUBSTACK_SID=... node scripts/probe.ts <subdomain>
// Solo richieste GET. Stampa stato HTTP e la forma (chiavi e tipi) della risposta, senza valori.
import { normalizeSid } from '../src/auth/store.ts';

const publication = process.argv[2];
if (!publication || !/^[a-z0-9-]+$/.test(publication)) {
  console.error('Uso: node scripts/probe.ts <subdomain>');
  process.exit(64);
}
const sid = normalizeSid(process.env.SUBSTACK_SID ?? '');

function shape(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0], depth + 1)];
  if (v === null) return 'null';
  if (typeof v === 'object') {
    if (depth > 3) return 'object';
    return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return typeof v;
}

const targets = [
  ['profile', 'https://substack.com/api/v1/user/profile/self'],
  ['drafts', `https://${publication}.substack.com/api/v1/post_management/drafts?offset=0&limit=5&order_by=draft_updated_at&order_direction=desc`],
] as const;

for (const [label, url] of targets) {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { cookie: `substack.sid=${sid}`, 'user-agent': 'substack-cli-probe', accept: 'application/json' },
  });
  const text = await res.text();
  let body: unknown = `(non JSON, ${text.length} byte)`;
  try { body = shape(JSON.parse(text)); } catch { /* resta il segnaposto */ }
  console.log(`## ${label}  ${url.replace(/\?.*/, '')}\nstatus: ${res.status}\nshape: ${JSON.stringify(body, null, 2)}\n`);
}
