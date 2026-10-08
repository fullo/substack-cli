# Substack CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI TypeScript (`substack`) che crea bozze di articoli, gestisce una coda di note, pubblica/schedula, e (opzionalmente) genera testo con un LLM, secondo lo spec `docs/superpowers/specs/2026-10-08-substack-cli-design.md`.

**Architecture:** Moduli piccoli con confini netti (`util`, `config`, `auth`, `markdown`, `substack`, `notes`, `generate`, `cli`). Solo `src/substack/` parla con Substack; `generate/` non conosce Substack. I test girano direttamente sui `.ts` (type stripping di Node ≥ 22.18, qui 24.18); `tsc` serve per typecheck e build di produzione in `dist/`.

**Tech Stack:** Node ≥ 22.18, TypeScript (solo sintassi "erasable": niente enum, parameter properties, namespace), `node:test`, runtime deps: `marked`, `yaml`, `zod@3` (nessuna dipendenza transitiva). Dev deps: `typescript`, `@types/node`, `@stryker-mutator/core`.

**Convenzioni valide per tutto il piano**
- Gli import relativi usano l'estensione `.ts` (`import { x } from './y.ts'`); gli import di soli tipi usano `import type`.
- Test unitari: `node --test tests/unit/<percorso>.test.ts`. Tutta la suite: `npm test`.
- Ogni commit termina con il trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (secondo `-m`).
- Gli endpoint Substack del Task 7–8 sono **candidati**: il Task 7 (Fase 0) li conferma e il Task 8 li riallinea alle risposte reali. Se la realtà differisce, si modificano solo `src/substack/*`, `src/markdown/prosemirror.ts` (nomi dei nodi) e `tests/helpers/fake-substack.ts`.
- Differenze volute rispetto allo spec (da riportare nello spec nel Task 1): `note add` accetta il testo come argomento oppure `-` per stdin; esiste `note unschedule`; `article schedule` accetta `--send-email`; `tags`/`section` del front-matter sono rimandati finché la Fase 0 non conferma gli endpoint; la mutazione gira sui soli test unitari; il binario compilato è `dist/cli/main.js`.

---

## Mappa dei file

| File | Responsabilità |
|---|---|
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`, `.gitattributes` | scaffold |
| `src/util/errors.ts` | errori tipizzati + exit code |
| `src/util/redact.ts` | redazione segreti |
| `src/util/clock.ts` | ora corrente (override solo test) + parsing date ISO con offset |
| `src/util/fs.ts` | scrittura atomica, lock file, lettura opzionale |
| `src/config/config.ts` | percorsi, schema zod, caricamento config |
| `src/auth/store.ts` | cookie/chiavi: validazione, env, file `0600` |
| `src/auth/guide.ts` | testo del tutorial `auth guide` |
| `src/auth/login.ts` | login Playwright opzionale |
| `src/markdown/frontmatter.ts` | front-matter YAML + schema |
| `src/markdown/prosemirror.ts` | token `marked` → documento ProseMirror, sicurezza link/immagini |
| `src/substack/schemas.ts` | schemi zod delle risposte |
| `src/substack/client.ts` | `SubstackClient` (HTTP, retry, errori) |
| `src/notes/store.ts` | coda note su file + transizioni di stato |
| `src/notes/publish.ts` | `publishOne`, `runDue`, classificazione errori |
| `src/generate/provider.ts` | interfaccia `Provider` |
| `src/generate/anthropic.ts`, `src/generate/openai-compat.ts` | provider via `fetch` |
| `src/generate/generate.ts` | prompt, estrazione/validazione output |
| `src/cli/context.ts` | `Ctx` e `createContext` |
| `src/cli/router.ts` | routing, `parseArgs`, gestione errori/exit code |
| `src/cli/shared.ts` | helper dei comandi (`makeClient`, `emit`, `readSource`…) |
| `src/cli/commands/{auth,article,note,generate,config}.ts` | comandi |
| `src/cli/main.ts` | entrypoint |
| `tests/helpers/*` | tmp dir, fetch finto, server finti, runner CLI |
| `tests/unit/**`, `tests/functional/**`, `tests/security/**` | test |
| `scripts/probe.ts` | sonda di sola lettura per la Fase 0 |
| `stryker.config.json` | mutation testing |
| `deploy/Dockerfile`, `deploy/k3s/*`, `deploy/systemd/*`, `README.md` | deploy e documentazione |

---

### Task 1: Scaffold del progetto

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`, `.gitattributes`, `tests/unit/smoke.test.ts`
- Modify: `docs/superpowers/specs/2026-10-08-substack-cli-design.md` (sezione "Emendamenti")

- [ ] **Step 1: Inizializza package.json e installa le dipendenze**

```bash
cd /f/GitHub/substack
cat > package.json <<'EOF'
{
  "name": "substack-cli",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "bin": { "substack": "dist/cli/main.js" },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.build.json",
    "test": "node --test \"tests/unit/**/*.test.ts\" \"tests/security/**/*.test.ts\" \"tests/functional/**/*.test.ts\"",
    "test:unit": "node --test \"tests/unit/**/*.test.ts\"",
    "test:functional": "node --test \"tests/functional/**/*.test.ts\"",
    "coverage": "node --test --experimental-test-coverage \"tests/unit/**/*.test.ts\"",
    "mutation": "stryker run"
  }
}
EOF
npm install --save-exact marked yaml zod@3
npm install --save-dev --save-exact typescript @types/node @stryker-mutator/core
```

Expected: `package.json` ora contiene `dependencies` con esattamente `marked`, `yaml`, `zod` e `devDependencies` con `typescript`, `@types/node`, `@stryker-mutator/core`.

- [ ] **Step 2: Verifica che le 3 dipendenze di runtime non abbiano dipendenze transitive**

Run: `npm ls --omit=dev --all`
Expected: albero con soli `marked`, `yaml`, `zod` (nessun figlio). Se compare un figlio, fermarsi e discuterne con l'utente.

- [ ] **Step 3: Crea tsconfig e file di configurazione**

```bash
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts"]
}
EOF
cat > tsconfig.build.json <<'EOF'
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "noEmit": false },
  "include": ["src/**/*.ts"]
}
EOF
printf 'node_modules\ndist\n.stryker-tmp\nreports\n*.tmp\n' > .gitignore
printf '* text=auto eol=lf\n' > .gitattributes
mkdir -p tests/unit tests/functional tests/security tests/helpers src scripts
```

- [ ] **Step 4: Smoke test e verifica che il type stripping funzioni**

`tests/unit/smoke.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('il runner esegue TypeScript direttamente', () => {
  const x: number = 1 + 1;
  assert.equal(x, 2);
});
```

Run: `node --test tests/unit/smoke.test.ts`
Expected: PASS (1 test). Se Node si lamenta di "Unknown file extension .ts", la versione è troppo vecchia: fermarsi.

Run: `npm run typecheck`
Expected: nessun errore.

- [ ] **Step 5: Emenda lo spec**

Aggiungi in fondo a `docs/superpowers/specs/2026-10-08-substack-cli-design.md`:

```markdown

## 15. Emendamenti emersi in fase di piano

- `note add` accetta il testo come argomento oppure `-` (stdin); aggiunto `note unschedule <id>`.
- `article schedule` accetta `--send-email` (default: nessuna email).
- `tags` e `section` del front-matter sono rimandati finché la Fase 0 non conferma gli endpoint; il front-matter v1 accetta solo `title` e `subtitle` (chiavi sconosciute = errore, mai ignorate in silenzio).
- Il runner di test usa il type stripping di Node (≥ 22.18): i test girano sui `.ts`; `tsc` serve per typecheck e build (`dist/cli/main.js`). La mutazione esegue i soli test unitari; i comandi CLI sono coperti dai test funzionali.
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold progetto TypeScript con type stripping" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Errori, redazione segreti, orologio

**Files:**
- Create: `src/util/errors.ts`, `src/util/redact.ts`, `src/util/clock.ts`, `tests/unit/util/errors.test.ts`, `tests/unit/util/redact.test.ts`, `tests/unit/util/clock.test.ts`
- Delete: `tests/unit/smoke.test.ts`

- [ ] **Step 1: Scrivi i test (falliscono)**

`tests/unit/util/errors.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiShapeError, AuthError, CliError, NetworkError, ProviderError,
  RateLimitError, StateError, UsageError,
} from '../../../src/util/errors.ts';

test('ogni errore ha il suo exit code e nome', () => {
  const cases: [CliError, number, string][] = [
    [new UsageError('x'), 64, 'UsageError'],
    [new AuthError('x'), 2, 'AuthError'],
    [new ApiShapeError('x'), 3, 'ApiShapeError'],
    [new NetworkError('x'), 4, 'NetworkError'],
    [new RateLimitError('x'), 4, 'RateLimitError'],
    [new ProviderError('x'), 5, 'ProviderError'],
    [new StateError('x'), 6, 'StateError'],
  ];
  for (const [err, code, name] of cases) {
    assert.ok(err instanceof CliError);
    assert.ok(err instanceof Error);
    assert.equal(err.exitCode, code);
    assert.equal(err.name, name);
    assert.equal(err.message, 'x');
  }
});

test('ApiShapeError conserva lo status HTTP, RateLimitError il retry-after', () => {
  assert.equal(new ApiShapeError('x', 404).httpStatus, 404);
  assert.equal(new ApiShapeError('x').httpStatus, undefined);
  assert.equal(new RateLimitError('x', 1500).retryAfterMs, 1500);
  assert.equal(new RateLimitError('x').retryAfterMs, undefined);
});
```

`tests/unit/util/redact.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearSecrets, redact, registerSecret } from '../../../src/util/redact.ts';

beforeEach(() => clearSecrets());

test('redige i segreti registrati ovunque compaiano', () => {
  registerSecret('s%3Asuper-secret-cookie-value');
  assert.equal(redact('err: s%3Asuper-secret-cookie-value fine'), 'err: [REDACTED] fine');
});

test('redige anche la variante decodificata e quella codificata', () => {
  registerSecret('s%3Asuper-secret-cookie-value');
  assert.equal(redact('x s:super-secret-cookie-value y'), 'x [REDACTED] y');
  registerSecret('s:another-secret-value');
  assert.equal(redact('x s%3Aanother-secret-value y'), 'x [REDACTED] y');
});

test('ignora segreti troppo corti (evita di mascherare testo comune)', () => {
  registerSecret('abc');
  assert.equal(redact('abc def'), 'abc def');
  registerSecret(undefined);
});

test('redige per pattern anche senza registrazione', () => {
  assert.equal(redact('cookie: substack.sid=abc123XYZ; path=/'), 'cookie: substack.sid=[REDACTED]; path=/');
  assert.equal(redact('key sk-ant-api03-AbCdEfGhIjK end'), 'key [REDACTED] end');
});
```

`tests/unit/util/clock.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentTime, parseFutureInstant, parseInstant } from '../../../src/util/clock.ts';
import { UsageError } from '../../../src/util/errors.ts';

test('currentTime ignora SUBSTACK_NOW senza il consenso esplicito di test', () => {
  const t = currentTime({ SUBSTACK_NOW: '2020-01-01T00:00:00Z' });
  assert.notEqual(t.getUTCFullYear(), 2020);
});

test('currentTime usa SUBSTACK_NOW solo con SUBSTACK_ALLOW_TEST_CLOCK=1', () => {
  const t = currentTime({ SUBSTACK_NOW: '2020-01-01T00:00:00Z', SUBSTACK_ALLOW_TEST_CLOCK: '1' });
  assert.equal(t.toISOString(), '2020-01-01T00:00:00.000Z');
});

test('currentTime ignora un SUBSTACK_NOW non valido', () => {
  const t = currentTime({ SUBSTACK_NOW: 'boh', SUBSTACK_ALLOW_TEST_CLOCK: '1' });
  assert.ok(!Number.isNaN(t.getTime()));
  assert.ok(t.getUTCFullYear() >= 2026);
});

test('parseInstant accetta Z e offset', () => {
  assert.equal(parseInstant('2026-10-09T09:00:00+02:00').toISOString(), '2026-10-09T07:00:00.000Z');
  assert.equal(parseInstant('2026-10-09T09:00Z').toISOString(), '2026-10-09T09:00:00.000Z');
  assert.equal(parseInstant('2026-10-09T09:00:30.5-05:00').toISOString(), '2026-10-09T14:00:30.500Z');
});

test('parseInstant rifiuta date senza offset, impossibili o malformate', () => {
  for (const bad of ['2026-10-09T09:00:00', '2026-10-09', '2026-02-30T10:00:00Z',
    '2026-13-01T10:00:00Z', '2026-10-09T24:00:00Z', '2026-10-09T10:60:00Z', 'domani', '']) {
    assert.throws(() => parseInstant(bad), UsageError, bad);
  }
});

test('parseInstant accetta il 29 febbraio solo negli anni bisestili', () => {
  assert.equal(parseInstant('2028-02-29T10:00:00Z').toISOString(), '2028-02-29T10:00:00.000Z');
  assert.throws(() => parseInstant('2027-02-29T10:00:00Z'), UsageError);
});

test('parseFutureInstant richiede una data strettamente futura', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  assert.throws(() => parseFutureInstant('2026-10-08T10:00:00Z', now), UsageError);
  assert.throws(() => parseFutureInstant('2026-10-08T09:59:59Z', now), UsageError);
  assert.equal(parseFutureInstant('2026-10-08T10:00:01Z', now).toISOString(), '2026-10-08T10:00:01.000Z');
});
```

- [ ] **Step 2: Esegui e verifica il fallimento**

Run: `rm tests/unit/smoke.test.ts; node --test tests/unit/util/errors.test.ts`
Expected: FAIL (`Cannot find module .../src/util/errors.ts`).

- [ ] **Step 3: Implementa**

`src/util/errors.ts`:

```ts
export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  constructor(message: string, exitCode: number, code: string) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.code = code;
  }
}

export class UsageError extends CliError {
  constructor(message: string) { super(message, 64, 'USAGE'); }
}

export class AuthError extends CliError {
  constructor(message: string) { super(message, 2, 'AUTH'); }
}

export class ApiShapeError extends CliError {
  readonly httpStatus: number | undefined;
  constructor(message: string, httpStatus?: number) {
    super(message, 3, 'API_SHAPE');
    this.httpStatus = httpStatus;
  }
}

export class NetworkError extends CliError {
  constructor(message: string) { super(message, 4, 'NETWORK'); }
}

export class RateLimitError extends CliError {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message, 4, 'RATE_LIMIT');
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderError extends CliError {
  constructor(message: string) { super(message, 5, 'PROVIDER'); }
}

export class StateError extends CliError {
  constructor(message: string) { super(message, 6, 'STATE'); }
}
```

`src/util/redact.ts`:

```ts
const secrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (!value || value.length < 8) return;
  secrets.add(value);
  try {
    secrets.add(decodeURIComponent(value));
  } catch {
    // valore non codificato: nessuna variante decodificata
  }
  secrets.add(encodeURIComponent(value));
}

export function clearSecrets(): void {
  secrets.clear();
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 8) out = out.split(s).join('[REDACTED]');
  }
  return out
    .replace(/substack\.sid=[^;\s"']+/gi, 'substack.sid=[REDACTED]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]');
}
```

`src/util/clock.ts`:

```ts
import { UsageError } from './errors.ts';

export function currentTime(env: NodeJS.ProcessEnv): Date {
  if (env.SUBSTACK_ALLOW_TEST_CLOCK === '1' && env.SUBSTACK_NOW) {
    const d = new Date(env.SUBSTACK_NOW);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(input: string): Date {
  const text = input.trim();
  const fail = (): never => {
    throw new UsageError(
      `Data non valida: "${input}". Usa ISO 8601 con offset, es. 2026-10-09T09:00:00+02:00 oppure 2026-10-09T07:00:00Z`,
    );
  };
  const m = ISO.exec(text);
  if (!m) return fail();
  const [, y, mo, d, h, mi, s] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > lastDay) return fail();
  if (Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59)) return fail();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return fail();
  return date;
}

export function parseFutureInstant(input: string, now: Date): Date {
  const date = parseInstant(input);
  if (date.getTime() <= now.getTime()) {
    throw new UsageError(`La data ${date.toISOString()} non è nel futuro`);
  }
  return date;
}
```

- [ ] **Step 4: Esegui i test**

Run: `node --test "tests/unit/util/*.test.ts"`
Expected: tutti PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(util): errori tipizzati, redazione segreti, parsing date" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: File system sicuro (scrittura atomica, lock)

**Files:**
- Create: `src/util/fs.ts`, `tests/helpers/tmp.ts`, `tests/unit/util/fs.test.ts`

- [ ] **Step 1: Helper e test (falliscono)**

`tests/helpers/tmp.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'substack-cli-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

`tests/unit/util/fs.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile, readTextIfExists, withLock } from '../../../src/util/fs.ts';
import { StateError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

test('atomicWriteFile crea cartelle, scrive e sovrascrive senza lasciare temporanei', async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, 'a', 'b', 'x.json');
    await atomicWriteFile(file, 'uno');
    await atomicWriteFile(file, 'due');
    assert.equal(await readFile(file, 'utf8'), 'due');
    assert.deepEqual(await readdir(join(dir, 'a', 'b')), ['x.json']);
  });
});

test('atomicWriteFile usa permessi 0600', { skip: process.platform === 'win32' }, async () => {
  await withTmpDir(async (dir) => {
    const file = join(dir, 'secret.json');
    await atomicWriteFile(file, 'x');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  });
});

test('readTextIfExists restituisce undefined se il file manca, rilancia altri errori', async () => {
  await withTmpDir(async (dir) => {
    assert.equal(await readTextIfExists(join(dir, 'nope')), undefined);
    await assert.rejects(readTextIfExists(dir)); // è una cartella: EISDIR
  });
});

test('withLock è esclusivo e si libera anche se fn lancia', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await withLock(lock, async () => {
      await assert.rejects(withLock(lock, async () => 1), StateError);
    });
    await assert.rejects(withLock(lock, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await withLock(lock, async () => 'ok'), 'ok');
  });
});

test('withLock recupera un lock vecchio (stale) ma non uno recente', async () => {
  await withTmpDir(async (dir) => {
    const lock = join(dir, '.lock');
    await writeFile(lock, '999999');
    await assert.rejects(withLock(lock, async () => 1, 60_000), StateError);
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    assert.equal(await withLock(lock, async () => 'recuperato', 60_000), 'recuperato');
  });
});
```

Run: `node --test tests/unit/util/fs.test.ts`
Expected: FAIL (modulo mancante).

- [ ] **Step 2: Implementa**

`src/util/fs.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { StateError } from './errors.ts';

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

export async function atomicWriteFile(path: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, { mode });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (errno(e) === 'ENOENT') return undefined;
    throw e;
  }
}

async function acquire(lockPath: string, staleMs: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (e) {
      if (errno(e) !== 'EEXIST') throw e;
      const st = await stat(lockPath).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > staleMs) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (!st) continue;
      throw new StateError(`Operazione già in corso (lock: ${lockPath})`);
    }
  }
  throw new StateError(`Impossibile acquisire il lock: ${lockPath}`);
}

export async function withLock<T>(lockPath: string, fn: () => Promise<T>, staleMs = 10 * 60_000): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  await acquire(lockPath, staleMs);
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}
```

- [ ] **Step 3: Esegui i test**

Run: `node --test tests/unit/util/fs.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(util): scrittura atomica e lock file" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Configurazione

**Files:**
- Create: `src/config/config.ts`, `tests/unit/config/config.test.ts`

- [ ] **Step 1: Test (falliscono)**

`tests/unit/config/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir, dataDir, globalUrl, loadConfig, publicationUrl } from '../../../src/config/config.ts';
import { UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

test('senza file di config: default validi', async () => {
  await withTmpDir(async (dir) => {
    const cfg = await loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir });
    assert.equal(cfg.generate.provider, 'anthropic');
    assert.equal(cfg.generate.maxTokens, 4096);
    assert.equal(cfg.generate.timeoutMs, 120000);
    assert.equal(cfg.publication, undefined);
  });
});

test('percorsi: override via env, altrimenti sotto la home', () => {
  assert.equal(configDir({ SUBSTACK_CLI_CONFIG_DIR: '/c' }), '/c');
  assert.equal(dataDir({ SUBSTACK_CLI_DATA_DIR: '/d' }), '/d');
  assert.match(configDir({}), /substack-cli$/);
  assert.match(dataDir({}), /substack-cli$/);
});

test('legge config.json e applica gli override da env', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publication: 'miaposta' }));
    const cfg = await loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir });
    assert.equal(cfg.publication, 'miaposta');
    const cfg2 = await loadConfig({ SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_PUBLICATION: 'altra' });
    assert.equal(cfg2.publication, 'altra');
  });
});

test('rifiuta chiavi sconosciute, subdomain non validi, JSON rotto', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publicaton: 'typo' }));
    await assert.rejects(loadConfig(env), UsageError);
    await writeFile(join(dir, 'config.json'), JSON.stringify({ publication: 'Ev il.com/x' }));
    await assert.rejects(loadConfig(env), UsageError);
    await writeFile(join(dir, 'config.json'), '{ rotto');
    await assert.rejects(loadConfig(env), /JSON/);
  });
});

test('baseUrl di Substack: https oppure http solo su localhost', async () => {
  await withTmpDir(async (dir) => {
    const base = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'http://127.0.0.1:8080' })).baseUrl, 'http://127.0.0.1:8080');
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'http://localhost:1' })).baseUrl, 'http://localhost:1');
    assert.equal((await loadConfig({ ...base, SUBSTACK_BASE_URL: 'https://example.com' })).baseUrl, 'https://example.com');
    for (const bad of ['http://evil.example.com', 'ftp://x', 'javascript:alert(1)', 'non-un-url']) {
      await assert.rejects(loadConfig({ ...base, SUBSTACK_BASE_URL: bad }), UsageError, bad);
    }
  });
});

test('publicationUrl e globalUrl', () => {
  const base = { generate: { provider: 'anthropic', model: 'm', maxTokens: 1, timeoutMs: 1000 } } as const;
  assert.equal(publicationUrl({ ...base, publication: 'foo' }), 'https://foo.substack.com');
  assert.equal(globalUrl({ ...base, publication: 'foo' }), 'https://substack.com');
  assert.equal(publicationUrl({ ...base, baseUrl: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
  assert.equal(globalUrl({ ...base, baseUrl: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9');
  assert.throws(() => publicationUrl({ ...base }), UsageError);
});
```

Run: `node --test tests/unit/config/config.test.ts` → FAIL (modulo mancante).

- [ ] **Step 2: Implementa**

`src/config/config.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readTextIfExists } from '../util/fs.ts';
import { UsageError } from '../util/errors.ts';

export function configDir(env: NodeJS.ProcessEnv): string {
  return env.SUBSTACK_CLI_CONFIG_DIR ?? join(homedir(), '.config', 'substack-cli');
}

export function dataDir(env: NodeJS.ProcessEnv): string {
  return env.SUBSTACK_CLI_DATA_DIR ?? join(homedir(), '.local', 'share', 'substack-cli');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isSafeSubstackBase(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

const ConfigSchema = z
  .object({
    publication: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'subdomain non valido').optional(),
    baseUrl: z.string().refine(isSafeSubstackBase, 'baseUrl deve essere https (http solo su localhost)').optional(),
    generate: z
      .object({
        provider: z.enum(['anthropic', 'openai-compat']).default('anthropic'),
        model: z.string().min(1).default('claude-sonnet-5-5'),
        baseUrl: z.string().url().optional(),
        maxTokens: z.number().int().min(1).max(64000).default(4096),
        timeoutMs: z.number().int().min(1000).max(600000).default(120000),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<Config> {
  const path = env.SUBSTACK_CLI_CONFIG ?? join(configDir(env), 'config.json');
  const text = await readTextIfExists(path);
  let raw: Record<string, unknown> = {};
  if (text !== undefined) {
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      throw new UsageError(`config.json non è JSON valido (${path}): ${(e as Error).message}`);
    }
  }
  if (env.SUBSTACK_PUBLICATION) raw = { ...raw, publication: env.SUBSTACK_PUBLICATION };
  if (env.SUBSTACK_BASE_URL) raw = { ...raw, baseUrl: env.SUBSTACK_BASE_URL };
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`).join('; ');
    throw new UsageError(`Configurazione non valida: ${issues}`);
  }
  return parsed.data;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function publicationUrl(config: Config): string {
  if (config.baseUrl) return trimSlash(config.baseUrl);
  if (config.publication) return `https://${config.publication}.substack.com`;
  throw new UsageError('Pubblicazione non configurata: esegui "substack config init --publication <subdomain>"');
}

export function globalUrl(config: Config): string {
  return trimSlash(config.baseUrl ?? 'https://substack.com');
}
```

- [ ] **Step 3: Esegui i test**

Run: `node --test tests/unit/config/config.test.ts && npm run typecheck`
Expected: PASS, typecheck pulito.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(config): caricamento e validazione configurazione" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Autenticazione (store dei segreti, guida)

**Files:**
- Create: `src/auth/store.ts`, `src/auth/guide.ts`, `tests/unit/auth/store.test.ts`

- [ ] **Step 1: Test (falliscono)**

`tests/unit/auth/store.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getApiKey, getSid, normalizeSid, saveSecret, secretsPermissionWarning } from '../../../src/auth/store.ts';
import { AuthError, UsageError } from '../../../src/util/errors.ts';
import { clearSecrets, redact } from '../../../src/util/redact.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const SID = 's%3AabcdefGHIJKLmnop1234567890.signature';

beforeEach(() => clearSecrets());

test('normalizeSid accetta il valore e il formato incollato "substack.sid=...;"', () => {
  assert.equal(normalizeSid(SID), SID);
  assert.equal(normalizeSid(`  substack.sid=${SID};  `), SID);
});

test('normalizeSid rifiuta valori che potrebbero iniettare header o sono troppo corti', () => {
  for (const bad of ['', 'corto', `${SID}; other=1`, `${SID}\r\nX-Evil: 1`, `${SID} spazio`, 'a'.repeat(5000)]) {
    assert.throws(() => normalizeSid(bad), UsageError, JSON.stringify(bad).slice(0, 30));
  }
});

test('getSid: env ha la precedenza sul file; senza nulla è AuthError', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    await assert.rejects(getSid(env), AuthError);
    await saveSecret(env, { sid: SID });
    assert.equal(await getSid(env), SID);
    const other = 's%3AaltroValoreDiCookie1234567890.sig';
    assert.equal(await getSid({ ...env, SUBSTACK_SID: other }), other);
  });
});

test('getSid registra il segreto per la redazione', async () => {
  await withTmpDir(async (dir) => {
    await getSid({ SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_SID: SID });
    assert.equal(redact(`errore con ${SID}`), 'errore con [REDACTED]');
  });
});

test('saveSecret unisce i campi, valida il cookie e usa permessi 0600', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    await saveSecret(env, { sid: SID });
    await saveSecret(env, { anthropicKey: 'sk-ant-test-key-1234' });
    const saved = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'));
    assert.deepEqual(saved, { sid: SID, anthropicKey: 'sk-ant-test-key-1234' });
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(dir, 'secrets.json'))).mode & 0o777, 0o600);
    }
    await assert.rejects(saveSecret(env, { sid: 'x; y' }), UsageError);
  });
});

test('getApiKey: env prima del file; anthropic e llm sono separate', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.equal(await getApiKey(env, 'anthropic'), undefined);
    await saveSecret(env, { anthropicKey: 'sk-ant-from-file-123', llmKey: 'llm-from-file-1234' });
    assert.equal(await getApiKey(env, 'anthropic'), 'sk-ant-from-file-123');
    assert.equal(await getApiKey({ ...env, ANTHROPIC_API_KEY: 'sk-ant-from-env-12345' }, 'anthropic'), 'sk-ant-from-env-12345');
    assert.equal(await getApiKey(env, 'llm'), 'llm-from-file-1234');
    assert.equal(await getApiKey({ ...env, SUBSTACK_LLM_API_KEY: 'llm-from-env-12345' }, 'llm'), 'llm-from-env-12345');
  });
});

test('file segreti corrotto o con chiavi sconosciute: errore chiaro', async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'secrets.json'), '{ rotto');
    await assert.rejects(getSid(env), /secrets\.json/);
    await writeFile(join(dir, 'secrets.json'), JSON.stringify({ sidd: 'x' }));
    await assert.rejects(getSid(env), /secrets\.json/);
  });
});

test('secretsPermissionWarning segnala file leggibili da altri (solo POSIX)', { skip: process.platform === 'win32' }, async () => {
  await withTmpDir(async (dir) => {
    const env = { SUBSTACK_CLI_CONFIG_DIR: dir };
    assert.equal(await secretsPermissionWarning(env), undefined);
    await saveSecret(env, { sid: SID });
    assert.equal(await secretsPermissionWarning(env), undefined);
    const { chmod } = await import('node:fs/promises');
    await chmod(join(dir, 'secrets.json'), 0o644);
    assert.match((await secretsPermissionWarning(env)) ?? '', /0600/);
  });
});
```

Run: `node --test tests/unit/auth/store.test.ts` → FAIL.

- [ ] **Step 2: Implementa**

`src/auth/store.ts`:

```ts
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { configDir } from '../config/config.ts';
import { AuthError, UsageError } from '../util/errors.ts';
import { atomicWriteFile, readTextIfExists } from '../util/fs.ts';
import { registerSecret } from '../util/redact.ts';

const SecretsSchema = z
  .object({
    sid: z.string().optional(),
    anthropicKey: z.string().optional(),
    llmKey: z.string().optional(),
  })
  .strict();

export type Secrets = z.infer<typeof SecretsSchema>;

const SID_RE = /^[A-Za-z0-9%._~+/=-]{16,2048}$/;

export function normalizeSid(input: string): string {
  const value = input.trim().replace(/^substack\.sid=/i, '').replace(/;$/, '').trim();
  if (!SID_RE.test(value)) {
    throw new UsageError(
      'Cookie non valido: copia solo il valore di "substack.sid" (nessuno spazio, punto e virgola o a capo). Vedi "substack auth guide".',
    );
  }
  return value;
}

export function secretsPath(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), 'secrets.json');
}

async function readSecrets(env: NodeJS.ProcessEnv): Promise<Secrets> {
  const path = secretsPath(env);
  const text = await readTextIfExists(path);
  if (text === undefined) return {};
  try {
    return SecretsSchema.parse(JSON.parse(text));
  } catch {
    throw new UsageError(`File dei segreti non valido: ${path} (rimuovilo e ripeti "substack auth set")`);
  }
}

export async function getSid(env: NodeJS.ProcessEnv): Promise<string> {
  const raw = env.SUBSTACK_SID ?? (await readSecrets(env)).sid;
  if (!raw) {
    throw new AuthError('Cookie di sessione non configurato. Esegui "substack auth guide" per le istruzioni.');
  }
  const sid = normalizeSid(raw);
  registerSecret(sid);
  return sid;
}

export async function getApiKey(env: NodeJS.ProcessEnv, which: 'anthropic' | 'llm'): Promise<string | undefined> {
  const fromEnv = which === 'anthropic' ? env.ANTHROPIC_API_KEY : env.SUBSTACK_LLM_API_KEY;
  const secrets = await readSecrets(env);
  const key = fromEnv ?? (which === 'anthropic' ? secrets.anthropicKey : secrets.llmKey);
  registerSecret(key);
  return key;
}

export async function saveSecret(env: NodeJS.ProcessEnv, patch: Secrets): Promise<void> {
  const next: Secrets = { ...(await readSecrets(env)), ...patch };
  if (next.sid !== undefined) next.sid = normalizeSid(next.sid);
  await atomicWriteFile(secretsPath(env), JSON.stringify(next, null, 2) + '\n', 0o600);
}

export async function secretsPermissionWarning(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  const st = await stat(secretsPath(env)).catch(() => undefined);
  if (st && (st.mode & 0o077) !== 0) {
    return `Il file ${secretsPath(env)} è leggibile da altri utenti: imposta i permessi a 0600 (chmod 600).`;
  }
  return undefined;
}
```

`src/auth/guide.ts`:

```ts
export const AUTH_GUIDE = `GUIDA: ottenere il cookie di sessione di Substack

Substack non ha API key: il CLI usa il cookie "substack.sid" del tuo account.
Trattalo come una password: chi lo possiede può agire come te.

1. Sul tuo PC apri https://substack.com e fai login.
2. Apri gli strumenti sviluppatore del browser (F12).
3. Chrome/Edge: scheda "Application" -> "Cookies" -> "https://substack.com".
   Firefox: scheda "Storage" -> "Cookies". Safari: "Archiviazione" -> "Cookie".
4. Trova la riga "substack.sid" e copia il suo VALORE (inizia di solito con "s%3A").
5. Salvalo sul dispositivo/VM dove gira il CLI, in uno di questi modi:
   a) interattivo (il valore non viene mostrato):   substack auth set
   b) da stdin (utile via SSH):                       printf '%s' "<valore>" | substack auth set
   c) variabile d'ambiente (senza file):              export SUBSTACK_SID="<valore>"
6. Verifica:  substack auth check
   Se risponde "Sessione valida", sei a posto.

Se non puoi caricare file sulla VM: usa (b) o (c) da una sessione SSH.
Se non hai un browser a portata di mano: sul tuo PC installa Playwright
(npm install --no-save playwright && npx playwright install chromium) ed esegui
"substack auth login": apre un browser, fai login a mano e il cookie viene salvato;
con "--print" lo stampa per copiarlo sulla VM.

Kubernetes (k3s): aggiorna il Secret senza ricreare nulla:
   kubectl -n substack create secret generic substack-secrets \\
     --from-literal=SUBSTACK_SID="<valore>" --dry-run=client -o yaml | kubectl apply -f -

Il cookie scade ogni tanto: quando "substack auth check" esce con codice 2,
ripeti questa guida.
`;
```

- [ ] **Step 3: Esegui i test e il typecheck**

Run: `node --test tests/unit/auth/store.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(auth): store dei segreti, validazione cookie, guida" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Markdown → ProseMirror e front-matter

**Files:**
- Create: `src/markdown/frontmatter.ts`, `src/markdown/prosemirror.ts`, `tests/unit/markdown/frontmatter.test.ts`, `tests/unit/markdown/prosemirror.test.ts`

I nomi dei nodi (`bullet_list`, `captionedImage`…) sono confinati in costanti in cima a `prosemirror.ts`: la Fase 0 li può correggere in un punto solo.

- [ ] **Step 1: Test del convertitore (falliscono)**

`tests/unit/markdown/prosemirror.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToDoc, unescapeHtml } from '../../../src/markdown/prosemirror.ts';
import { UsageError } from '../../../src/util/errors.ts';

const first = (md: string) => markdownToDoc(md).content[0]!;

test('paragrafo con grassetto, corsivo e codice', () => {
  assert.deepEqual(first('Ciao **mondo**').content, [
    { type: 'text', text: 'Ciao ' },
    { type: 'text', text: 'mondo', marks: [{ type: 'strong' }] },
  ]);
  const p = first('a *b* `c`').content!;
  assert.deepEqual(p[1], { type: 'text', text: 'b', marks: [{ type: 'em' }] });
  assert.deepEqual(p[3], { type: 'text', text: 'c', marks: [{ type: 'code' }] });
});

test('marchi annidati si accumulano', () => {
  const n = first('***x***').content!.flatMap((x) => x.marks ?? []).map((m) => m.type).sort();
  assert.deepEqual(n, ['em', 'strong']);
});

test('titoli h1-h4 con livello; h5 e h6 sono rifiutati', () => {
  const doc = markdownToDoc('# Uno\n\n## Due\n\n#### Quattro');
  assert.deepEqual(doc.content.map((n) => [n.type, n.attrs?.level]), [['heading', 1], ['heading', 2], ['heading', 4]]);
  assert.throws(() => markdownToDoc('##### Cinque'), UsageError);
});

test('liste puntate, numerate e annidate', () => {
  const list = first('- uno\n- due\n  - annidato');
  assert.equal(list.type, 'bullet_list');
  assert.equal(list.content!.length, 2);
  const secondItem = list.content![1]!;
  assert.equal(secondItem.type, 'list_item');
  assert.deepEqual(secondItem.content!.map((n) => n.type), ['paragraph', 'bullet_list']);
  assert.equal(first('1. a\n2. b').type, 'ordered_list');
});

test('citazione, codice, separatore', () => {
  assert.equal(first('> citazione').type, 'blockquote');
  const code = first('```js\nlet x = 1 < 2 && 3;\n```');
  assert.equal(code.type, 'code_block');
  assert.equal(code.attrs?.language, 'js');
  assert.equal(code.content![0]!.text, 'let x = 1 < 2 && 3;');
  assert.equal(first('---').type, 'horizontal_rule');
});

test('le entità HTML introdotte dal lexer vengono ripristinate', () => {
  assert.equal(unescapeHtml('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), `a & b <c> "d" 'e'`);
  assert.equal(unescapeHtml('&amp;lt;'), '&lt;');
  assert.equal(first('A & B < C "q"').content![0]!.text, 'A & B < C "q"');
  assert.equal(first('`<b>&</b>`').content![0]!.text, '<b>&</b>');
});

test('link: ammessi http, https, mailto; vietati gli altri schemi e i relativi', () => {
  const link = first('[sito](https://example.com/a)').content![0]!;
  assert.deepEqual(link.marks, [{ type: 'link', attrs: { href: 'https://example.com/a' } }]);
  assert.ok(first('[m](mailto:a@b.it)').content![0]!.marks);
  for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html;base64,AAAA)', '[x](ftp://a.b)',
    '[x](/relativo)', '[x](file:///etc/passwd)', '[x](JaVaScRiPt:alert(1))']) {
    assert.throws(() => markdownToDoc(bad), UsageError, bad);
  }
});

test('immagine su paragrafo a sé, solo https; inline o http rifiutate', () => {
  const img = first('![testo alt](https://example.com/i.png)');
  assert.equal(img.type, 'captionedImage');
  assert.equal(JSON.stringify(img).includes('https://example.com/i.png'), true);
  assert.throws(() => markdownToDoc('![a](http://example.com/i.png)'), UsageError);
  assert.throws(() => markdownToDoc('testo ![a](https://example.com/i.png) altro'), UsageError);
  assert.throws(() => markdownToDoc('![a](javascript:alert(1))'), UsageError);
});

test('HTML grezzo, tabelle e task list sono errori espliciti', () => {
  assert.throws(() => markdownToDoc('<script>alert(1)</script>'), UsageError);
  assert.throws(() => markdownToDoc('ciao <b>x</b>'), UsageError);
  assert.throws(() => markdownToDoc('| a | b |\n|---|---|\n| 1 | 2 |'), UsageError);
  assert.throws(() => markdownToDoc('- [ ] da fare'), UsageError);
});

test('contenuto vuoto, caratteri di controllo e bidi sono rifiutati', () => {
  assert.throws(() => markdownToDoc(''), UsageError);
  assert.throws(() => markdownToDoc('   \n\n'), UsageError);
  assert.throws(() => markdownToDoc('a\u0000b'), UsageError);
  assert.throws(() => markdownToDoc('a\u202Eb'), UsageError);
  assert.equal(markdownToDoc('a\tb\nc').content.length, 1); // tab e a capo sono ammessi
});

test('limiti: annidamento eccessivo e input enorme', () => {
  const deep = Array.from({ length: 60 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n');
  assert.throws(() => markdownToDoc(deep), UsageError);
  assert.throws(() => markdownToDoc('a'.repeat(1_000_001)), UsageError);
  assert.throws(() => markdownToDoc('> '.repeat(60) + 'x'), UsageError);
});
```

Run: `node --test tests/unit/markdown/prosemirror.test.ts` → FAIL (modulo mancante).

- [ ] **Step 2: Implementa `prosemirror.ts`**

```ts
import { marked } from 'marked';
import type { Token, Tokens } from 'marked';
import { UsageError } from '../util/errors.ts';

export interface PMMark { type: string; attrs?: Record<string, unknown> }
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
}
export interface PMDoc { type: 'doc'; content: PMNode[] }

// Nomi dei nodi attesi da Substack: confermati/corretti nella Fase 0 (Task 7).
const NODE = {
  paragraph: 'paragraph',
  heading: 'heading',
  bulletList: 'bullet_list',
  orderedList: 'ordered_list',
  listItem: 'list_item',
  blockquote: 'blockquote',
  codeBlock: 'code_block',
  rule: 'horizontal_rule',
  hardBreak: 'hard_break',
  image: (src: string, alt: string | null): PMNode => ({
    type: 'captionedImage',
    content: [{ type: 'image2', attrs: { src, alt } }],
  }),
};

const MAX_DEPTH = 20;
const MAX_INPUT = 1_000_000;
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const IMAGE_SCHEMES = new Set(['https:']);
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

export function unescapeHtml(s: string): string {
  const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => map[e] ?? '');
}

function safeUrl(href: string, allowed: Set<string>, what: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new UsageError(`${what} non valido (serve un URL assoluto): ${href}`);
  }
  if (!allowed.has(url.protocol)) {
    throw new UsageError(`${what} con schema non consentito (${url.protocol}): ${href}`);
  }
  return url.href;
}

function pushText(out: PMNode[], text: string, marks: PMMark[]): void {
  if (text === '') return;
  out.push(marks.length > 0 ? { type: 'text', text, marks: marks.map((m) => ({ ...m })) } : { type: 'text', text });
}

function guard(depth: number): void {
  if (depth > MAX_DEPTH) throw new UsageError('Markdown troppo annidato');
}

function inline(tokens: Token[], marks: PMMark[], depth: number): PMNode[] {
  guard(depth);
  const out: PMNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
      case 'escape': {
        const tt = t as Tokens.Text | Tokens.Escape;
        const children = 'tokens' in tt ? tt.tokens : undefined;
        if (children && children.length > 0) out.push(...inline(children, marks, depth + 1));
        else pushText(out, unescapeHtml(tt.text), marks);
        break;
      }
      case 'strong':
        out.push(...inline((t as Tokens.Strong).tokens, [...marks, { type: 'strong' }], depth + 1));
        break;
      case 'em':
        out.push(...inline((t as Tokens.Em).tokens, [...marks, { type: 'em' }], depth + 1));
        break;
      case 'codespan':
        pushText(out, unescapeHtml((t as Tokens.Codespan).text), [...marks, { type: 'code' }]);
        break;
      case 'link': {
        const l = t as Tokens.Link;
        const href = safeUrl(l.href, LINK_SCHEMES, 'Link');
        out.push(...inline(l.tokens, [...marks, { type: 'link', attrs: { href } }], depth + 1));
        break;
      }
      case 'br':
        out.push({ type: NODE.hardBreak });
        break;
      case 'image':
        throw new UsageError('Immagine inline non supportata: mettila in un paragrafo a sé');
      default:
        throw new UsageError(`Markdown non supportato (inline): ${t.type}`);
    }
  }
  return out;
}

function paragraph(tokens: Token[], depth: number): PMNode | undefined {
  const meaningful = tokens.filter((t) => !(t.type === 'text' && (t as Tokens.Text).text.trim() === ''));
  if (meaningful.length === 1 && meaningful[0]!.type === 'image') {
    const img = meaningful[0] as Tokens.Image;
    return NODE.image(safeUrl(img.href, IMAGE_SCHEMES, 'Immagine'), unescapeHtml(img.text) || null);
  }
  const content = inline(tokens, [], depth + 1);
  return content.length > 0 ? { type: NODE.paragraph, content } : undefined;
}

function blocks(tokens: Token[], depth: number): PMNode[] {
  guard(depth);
  const out: PMNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'heading': {
        const h = t as Tokens.Heading;
        if (h.depth > 4) throw new UsageError(`Titoli supportati solo fino al livello 4 (trovato h${h.depth})`);
        const content = inline(h.tokens, [], depth + 1);
        if (content.length > 0) out.push({ type: NODE.heading, attrs: { level: h.depth }, content });
        break;
      }
      case 'paragraph':
      case 'text': {
        const tt = t as Tokens.Paragraph | Tokens.Text;
        const tokensOfBlock = ('tokens' in tt && tt.tokens ? tt.tokens : [t]) as Token[];
        const p = paragraph(tokensOfBlock, depth);
        if (p) out.push(p);
        break;
      }
      case 'list': {
        const l = t as Tokens.List;
        const items = l.items.map((it): PMNode => {
          if (it.task) throw new UsageError('Le task list non sono supportate');
          return { type: NODE.listItem, content: blocks(it.tokens, depth + 1) };
        });
        out.push({ type: l.ordered ? NODE.orderedList : NODE.bulletList, content: items });
        break;
      }
      case 'blockquote':
        out.push({ type: NODE.blockquote, content: blocks((t as Tokens.Blockquote).tokens, depth + 1) });
        break;
      case 'code': {
        const c = t as Tokens.Code;
        out.push({
          type: NODE.codeBlock,
          attrs: { language: c.lang ? c.lang : null },
          content: c.text ? [{ type: 'text', text: c.text }] : [],
        });
        break;
      }
      case 'hr':
        out.push({ type: NODE.rule });
        break;
      default:
        throw new UsageError(`Markdown non supportato: ${t.type}`);
    }
  }
  return out;
}

export function markdownToDoc(markdown: string): PMDoc {
  if (markdown.length > MAX_INPUT) throw new UsageError('Contenuto troppo grande (max 1 MB)');
  if (FORBIDDEN_CHARS.test(markdown)) {
    throw new UsageError('Il testo contiene caratteri di controllo o di direzione non ammessi');
  }
  const content = blocks(marked.lexer(markdown, { gfm: true }), 0);
  if (content.length === 0) throw new UsageError('Contenuto vuoto');
  return { type: 'doc', content };
}
```

- [ ] **Step 3: Esegui i test del convertitore**

Run: `node --test tests/unit/markdown/prosemirror.test.ts`
Expected: PASS. Se un caso fallisce perché `marked` tokenizza in modo diverso da quanto assunto (es. entità, task, tabelle), stampa i token con `node -e "import('marked').then(m=>console.log(JSON.stringify(m.marked.lexer('...'),null,1)))"` e correggi il **mapper**, non il test, mantenendo le garanzie di sicurezza.

- [ ] **Step 4: Test del front-matter (falliscono)**

`tests/unit/markdown/frontmatter.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArticle } from '../../../src/markdown/frontmatter.ts';
import { UsageError } from '../../../src/util/errors.ts';

const OK = '---\ntitle: Il mio titolo\nsubtitle: "Con: due punti"\n---\n\nCorpo **qui**.\n';

test('legge title e subtitle e converte il corpo', () => {
  const a = parseArticle(OK);
  assert.equal(a.frontMatter.title, 'Il mio titolo');
  assert.equal(a.frontMatter.subtitle, 'Con: due punti');
  assert.equal(a.doc.content[0]!.type, 'paragraph');
});

test('accetta CRLF e subtitle assente', () => {
  const a = parseArticle('---\r\ntitle: T\r\n---\r\n\r\nCiao\r\n');
  assert.equal(a.frontMatter.subtitle, undefined);
  assert.equal(a.doc.content.length, 1);
});

test('front-matter mancante, non chiuso o senza title: errore', () => {
  assert.throws(() => parseArticle('Solo corpo'), UsageError);
  assert.throws(() => parseArticle('---\ntitle: T\nCorpo senza chiusura'), UsageError);
  assert.throws(() => parseArticle('---\nsubtitle: x\n---\n\nCorpo'), UsageError);
  assert.throws(() => parseArticle('---\ntitle: ""\n---\n\nCorpo'), UsageError);
});

test('chiavi sconosciute e YAML pericoloso/rotto sono rifiutati', () => {
  assert.throws(() => parseArticle('---\ntitle: T\ntags: [a]\n---\n\nCorpo'), /tags/);
  assert.throws(() => parseArticle('---\ntitle: [rotto\n---\n\nCorpo'), UsageError);
  assert.throws(() => parseArticle('---\na: &x [1]\ntitle: *x\n---\n\nCorpo'), UsageError);
  assert.throws(() => parseArticle('---\ntitle: T\ntitle: U\n---\n\nCorpo'), UsageError);
});

test('title non stringa o troppo lungo: errore', () => {
  assert.throws(() => parseArticle('---\ntitle: 123\n---\n\nCorpo'), UsageError);
  assert.throws(() => parseArticle(`---\ntitle: ${'a'.repeat(301)}\n---\n\nCorpo`), UsageError);
});

test('un "---" nel corpo non chiude di nuovo il front-matter', () => {
  const a = parseArticle('---\ntitle: T\n---\n\nPrima\n\n---\n\nDopo\n');
  assert.deepEqual(a.doc.content.map((n) => n.type), ['paragraph', 'horizontal_rule', 'paragraph']);
});

test('corpo vuoto: errore', () => {
  assert.throws(() => parseArticle('---\ntitle: T\n---\n\n'), UsageError);
});
```

Run: `node --test tests/unit/markdown/frontmatter.test.ts` → FAIL.

- [ ] **Step 5: Implementa `frontmatter.ts`**

```ts
import { parse } from 'yaml';
import { z } from 'zod';
import { UsageError } from '../util/errors.ts';
import { markdownToDoc } from './prosemirror.ts';
import type { PMDoc } from './prosemirror.ts';

const FrontMatterSchema = z
  .object({
    title: z.string().min(1).max(300),
    subtitle: z.string().max(500).optional(),
  })
  .strict();

export type FrontMatter = z.infer<typeof FrontMatterSchema>;

export interface ParsedArticle {
  frontMatter: FrontMatter;
  doc: PMDoc;
}

export function parseArticle(source: string): ParsedArticle {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    throw new UsageError('Front-matter mancante: il file deve iniziare con "---" e contenere almeno "title"');
  }
  const end = text.indexOf('\n---', 4);
  const afterFence = end === -1 ? undefined : text.slice(end + 4);
  if (end === -1 || (afterFence !== '' && !afterFence?.startsWith('\n'))) {
    throw new UsageError('Front-matter non chiuso: manca la riga "---" di chiusura');
  }
  const yamlText = text.slice(4, end);
  let data: unknown;
  try {
    data = parse(yamlText, { maxAliasCount: 0, schema: 'core', uniqueKeys: true });
  } catch (e) {
    throw new UsageError(`Front-matter YAML non valido: ${(e as Error).message}`);
  }
  const parsed = FrontMatterSchema.safeParse(data ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(radice)'}: ${i.message}`)
      .join('; ');
    throw new UsageError(`Front-matter non valido: ${issues}`);
  }
  const body = (afterFence ?? '').replace(/^\n/, '');
  return { frontMatter: parsed.data, doc: markdownToDoc(body) };
}
```

- [ ] **Step 6: Esegui tutti i test Markdown, typecheck, commit**

Run: `node --test "tests/unit/markdown/*.test.ts" && npm run typecheck`
Expected: PASS.

```bash
git add -A && git commit -m "feat(markdown): front-matter e convertitore Markdown->ProseMirror sicuro" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Fase 0 — scoperta delle API (sonda di sola lettura)

**Files:**
- Create: `scripts/probe.ts`, `tests/fixtures/README.md`

Questo task richiede il cookie reale dell'utente e la sua collaborazione. **Non** eseguire richieste di scrittura senza l'ok esplicito dell'utente in chat.

- [ ] **Step 1: Scrivi la sonda (stampa solo la FORMA delle risposte, mai i valori)**

`scripts/probe.ts`:

```ts
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
```

- [ ] **Step 2: Esegui la sonda con l'utente**

Chiedi all'utente di eseguire (il cookie non transita in chat):

```bash
SUBSTACK_SID="<valore>" node scripts/probe.ts <subdomain>
```

e di incollare l'output. Registra le forme in `tests/fixtures/README.md` (data, endpoint, forma).
Expected: `status: 200` per entrambi. Se 401/403, il cookie è scaduto o l'endpoint è cambiato → discutere con l'utente.

- [ ] **Step 3: Conferma le forme di scrittura (SOLO con ok esplicito dell'utente)**

Chiedi all'utente se vuole autorizzare, su una pubblicazione di prova o con bozze che poi cancella:
1. creare una bozza "TEST-CLI" (corpo: un paragrafo, un titolo, una lista) e ispezionare la risposta e il JSON del corpo salvato in Substack (aprendo la bozza e ispezionando la richiesta di salvataggio nel browser, scheda Network);
2. verificare la forma della richiesta di *schedule/cancel* e di *publish* **solo ispezionando il browser** (senza eseguirle);
3. verificare la forma della richiesta di una nota (ispezionando la richiesta del browser mentre l'utente pubblica una nota di prova a mano).

Per ogni punto, annota in `tests/fixtures/README.md`: metodo, percorso, corpo della richiesta (anonimizzato), forma della risposta, nomi dei nodi del corpo (`bullet_list` vs `bulletList`, struttura delle immagini).
Se l'utente non autorizza: i punti restano "non confermati" e la v1 resta marcata *beta* nel README; i test sul fake server verificano comunque il contratto interno.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: sonda di sola lettura per la scoperta delle API (fase 0)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: SubstackClient

**Files:**
- Create: `src/substack/schemas.ts`, `src/substack/client.ts`, `tests/helpers/fetch.ts`, `tests/unit/substack/client.test.ts`

Gli endpoint e le forme sotto sono quelli candidati. **Prima di scrivere**, riallineali a quanto annotato in `tests/fixtures/README.md` (Task 7): cambia solo percorsi, corpi e schemi qui sotto, tenendo i test coerenti.

- [ ] **Step 1: Helper fetch finto e test (falliscono)**

`tests/helpers/fetch.ts`:

```ts
export interface Call { url: string; init: RequestInit }
export type Route = (call: Call) => Response | Promise<Response>;

export function makeFetch(route: Route, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return route(call);
  }) as typeof fetch;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
```

`tests/unit/substack/client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubstackClient, parseDraftId } from '../../../src/substack/client.ts';
import { ApiShapeError, AuthError, NetworkError, RateLimitError, UsageError } from '../../../src/util/errors.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call, Route } from '../../helpers/fetch.ts';

const SID = 's%3AabcdefGHIJKLmnop1234567890.signature';
const PUB = 'https://pub.example';
const GLOBAL = 'https://glob.example';

function client(route: Route, calls: Call[] = [], sleeps: number[] = []) {
  return new SubstackClient({
    sid: SID,
    publicationUrl: PUB,
    globalUrl: GLOBAL,
    fetchImpl: makeFetch(route, calls),
    sleep: async (ms) => { sleeps.push(ms); },
  });
}

const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);

test('getProfile: cookie, user-agent, nessun redirect seguito, risposta validata', async () => {
  const calls: Call[] = [];
  const c = client(() => json({ id: 42, name: 'Ada', handle: 'ada', extra: 1 }), calls);
  const p = await c.getProfile();
  assert.equal(p.id, 42);
  assert.equal(calls[0]!.url, `${GLOBAL}/api/v1/user/profile/self`);
  assert.equal(header(calls[0]!, 'cookie'), `substack.sid=${SID}`);
  assert.match(header(calls[0]!, 'user-agent') ?? '', /substack-cli/);
  assert.equal(calls[0]!.init.redirect, 'manual');
  assert.ok(calls[0]!.init.signal);
});

test('401 e 403 → AuthError con rimando alla guida', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(client(() => json({}, status)).getProfile(), (e: Error) =>
      e instanceof AuthError && /auth guide/.test(e.message));
  }
});

test('risposta con forma errata → ApiShapeError che nomina endpoint e campo', async () => {
  await assert.rejects(client(() => json({ id: 'non-numero' })).getProfile(), (e: Error) =>
    e instanceof ApiShapeError && /user\/profile\/self/.test(e.message) && /id/.test(e.message));
  await assert.rejects(client(() => new Response('<html>', { status: 200 })).getProfile(), ApiShapeError);
});

test('stato inatteso 4xx → ApiShapeError con httpStatus', async () => {
  await assert.rejects(client(() => json({}, 404)).getProfile(), (e: Error) =>
    e instanceof ApiShapeError && (e as ApiShapeError).httpStatus === 404);
});

test('redirect non seguito → NetworkError', async () => {
  await assert.rejects(
    client(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })).getProfile(),
    NetworkError,
  );
});

test('GET idempotente: ritenta 503 con backoff e poi riesce', async () => {
  let n = 0;
  const sleeps: number[] = [];
  const c = client(() => (++n < 3 ? json({}, 503) : json({ id: 1 })), [], sleeps);
  assert.equal((await c.getProfile()).id, 1);
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('GET: dopo 3 tentativi falliti rilancia NetworkError', async () => {
  let n = 0;
  await assert.rejects(client(() => { n++; return json({}, 503); }).getProfile(), NetworkError);
  assert.equal(n, 3);
});

test('429 su GET: rispetta Retry-After (con tetto), poi ritenta', async () => {
  let n = 0;
  const sleeps: number[] = [];
  const c = client(() => (++n === 1 ? json({}, 429, { 'retry-after': '2' }) : json({ id: 1 })), [], sleeps);
  await c.getProfile();
  assert.deepEqual(sleeps, [2000]);
  let m = 0;
  const sleeps2: number[] = [];
  await client(() => (++m === 1 ? json({}, 429, { 'retry-after': '9999' }) : json({ id: 1 })), [], sleeps2).getProfile();
  assert.deepEqual(sleeps2, [30000]);
});

test('operazioni non idempotenti (createDraft, publish, postNote) non vengono mai ritentate', async () => {
  for (const status of [429, 503]) {
    let n = 0;
    const c = client(() => { n++; return json({}, status); });
    await assert.rejects(c.createDraft({ title: 't', body: { type: 'doc', content: [] }, authorId: 1 }),
      status === 429 ? RateLimitError : NetworkError);
    await assert.rejects(c.publishDraft(5, { sendEmail: false }));
    await assert.rejects(c.postNote({ type: 'doc', content: [] }));
    assert.equal(n, 3);
  }
});

test('errore di rete o timeout → NetworkError senza rivelare il cookie', async () => {
  const c = client(() => { throw new Error(`connessione rifiutata con substack.sid=${SID}`); });
  await assert.rejects(c.getProfile(), (e: Error) => e instanceof NetworkError && !e.message.includes(SID));
});

test('corpo di risposta troppo grande → ApiShapeError', async () => {
  const big = 'x'.repeat(5_000_001);
  await assert.rejects(client(() => new Response(big, { status: 200 })).getProfile(), ApiShapeError);
});

test('createDraft: percorso, corpo e URL di modifica', async () => {
  const calls: Call[] = [];
  const doc = { type: 'doc' as const, content: [{ type: 'paragraph' }] };
  const c = client(() => json({ id: 1001 }), calls);
  const r = await c.createDraft({ title: 'Titolo', subtitle: 'Sotto', body: doc, authorId: 42 });
  assert.deepEqual(r, { id: 1001, url: `${PUB}/publish/post/1001` });
  assert.equal(calls[0]!.url, `${PUB}/api/v1/drafts`);
  assert.equal(calls[0]!.init.method, 'POST');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.draft_title, 'Titolo');
  assert.equal(body.draft_subtitle, 'Sotto');
  assert.deepEqual(JSON.parse(body.draft_body), doc);
  assert.deepEqual(body.draft_bylines, [{ id: 42, is_guest: false }]);
  assert.equal(header(calls[0]!, 'content-type'), 'application/json');
});

test('listDrafts e getDraft', async () => {
  const calls: Call[] = [];
  const c = client((call) => call.url.includes('post_management')
    ? json({ posts: [{ id: 7, draft_title: 'A' }, { id: 8, draft_title: null }] })
    : json({ id: 7, draft_title: 'A' }), calls);
  assert.deepEqual((await c.listDrafts()).map((d) => d.id), [7, 8]);
  assert.match(calls[0]!.url, /^https:\/\/pub\.example\/api\/v1\/post_management\/drafts\?/);
  assert.equal((await c.getDraft(7)).draft_title, 'A');
  assert.equal(calls[1]!.url, `${PUB}/api/v1/drafts/7`);
});

test('publishDraft / scheduleDraft / cancelSchedule', async () => {
  const calls: Call[] = [];
  const c = client(() => json({}), calls);
  await c.publishDraft(5, { sendEmail: false });
  await c.publishDraft(5, { sendEmail: true });
  assert.equal(calls[0]!.url, `${PUB}/api/v1/drafts/5/publish`);
  assert.equal(JSON.parse(String(calls[0]!.init.body)).send, false);
  assert.equal(JSON.parse(String(calls[1]!.init.body)).send, true);

  await c.scheduleDraft(5, new Date('2026-10-09T07:00:00Z'), { sendEmail: false });
  assert.equal(calls[2]!.url, `${PUB}/api/v1/drafts/5/scheduled_release`);
  const sch = JSON.parse(String(calls[2]!.init.body));
  assert.equal(sch.trigger_at, '2026-10-09T07:00:00.000Z');
  assert.equal(sch.email_audience, 'no_one');
  await c.scheduleDraft(5, new Date('2026-10-09T07:00:00Z'), { sendEmail: true });
  assert.equal(JSON.parse(String(calls[3]!.init.body)).email_audience, 'everyone');

  await c.cancelSchedule(5);
  assert.equal(JSON.parse(String(calls[4]!.init.body)).trigger_at, null);
});

test('postNote: endpoint globale e id restituito come stringa', async () => {
  const calls: Call[] = [];
  const doc = { type: 'doc' as const, content: [{ type: 'paragraph' }] };
  const r = await client(() => json({ id: 123 }), calls).postNote(doc);
  assert.equal(r.id, '123');
  assert.equal(calls[0]!.url, `${GLOBAL}/api/v1/comment/feed`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)).bodyJson, doc);
});

test('parseDraftId accetta solo interi positivi (no path traversal)', () => {
  assert.equal(parseDraftId('123'), 123);
  for (const bad of [undefined, '', '0', '-1', '1.5', 'abc', '../x', '1/../2', '12345678901234567890', '1 ']) {
    assert.throws(() => parseDraftId(bad), UsageError, String(bad));
  }
});
```

Run: `node --test tests/unit/substack/client.test.ts` → FAIL.

- [ ] **Step 2: Implementa schemi e client**

`src/substack/schemas.ts`:

```ts
import { z } from 'zod';

export const ProfileSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
    handle: z.string().nullable().optional(),
  })
  .passthrough();

export const DraftCreatedSchema = z.object({ id: z.number().int().positive() }).passthrough();

export const DraftSchema = z
  .object({
    id: z.number().int().positive(),
    draft_title: z.string().nullable().optional(),
    draft_subtitle: z.string().nullable().optional(),
    audience: z.string().nullable().optional(),
  })
  .passthrough();

export const DraftListSchema = z.object({ posts: z.array(DraftSchema) }).passthrough();

export const NoteCreatedSchema = z.object({ id: z.union([z.number().int(), z.string().min(1)]) }).passthrough();

export const AnySchema = z.unknown();

export type Profile = z.infer<typeof ProfileSchema>;
export type Draft = z.infer<typeof DraftSchema>;
```

`src/substack/client.ts`:

```ts
import type { z } from 'zod';
import type { PMDoc } from '../markdown/prosemirror.ts';
import { ApiShapeError, AuthError, NetworkError, RateLimitError, UsageError } from '../util/errors.ts';
import { AnySchema, DraftCreatedSchema, DraftListSchema, DraftSchema, NoteCreatedSchema, ProfileSchema } from './schemas.ts';
import type { Draft, Profile } from './schemas.ts';

const MAX_BODY = 5_000_000;
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
      throw new NetworkError(`Richiesta a ${host}${path} fallita: ${(e as Error).message}`);
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
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY) throw new ApiShapeError(`Risposta troppo grande su ${path}`, res.status);
    const text = await res.text();
    if (text.length > MAX_BODY) throw new ApiShapeError(`Risposta troppo grande su ${path}`, res.status);
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
```

- [ ] **Step 3: Esegui test e typecheck**

Run: `node --test tests/unit/substack/client.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(substack): client HTTP con retry, validazione e errori tipizzati" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Coda delle note e pubblicazione

**Files:**
- Create: `src/notes/store.ts`, `src/notes/publish.ts`, `tests/unit/notes/store.test.ts`, `tests/unit/notes/publish.test.ts`

- [ ] **Step 1: Test dello store (falliscono)**

`tests/unit/notes/store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NoteStore } from '../../../src/notes/store.ts';
import { StateError, UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';

const NOW = new Date('2026-10-08T10:00:00Z');

test('add crea una nota draft con id esadecimale di 12 caratteri', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('Ciao **mondo**', NOW);
    assert.match(n.id, /^[0-9a-f]{12}$/);
    assert.equal(n.status, 'draft');
    assert.equal(n.createdAt, NOW.toISOString());
    assert.deepEqual((await readdir(dir)).sort(), [`${n.id}.json`]);
    assert.deepEqual(await store.get(n.id), n);
  });
});

test('add valida il contenuto: vuoto, non supportato, troppo lungo', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await assert.rejects(store.add('', NOW), UsageError);
    await assert.rejects(store.add('<script>x</script>', NOW), UsageError);
    await assert.rejects(store.add('a'.repeat(5001), NOW), UsageError);
    assert.equal((await store.list()).notes.length, 0);
  });
});

test('gli id non esadecimali (path traversal) sono rifiutati', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    for (const bad of ['../x', '..\\x', 'abc', 'ZZZZZZZZZZZZ', '', '0123456789ab/..']) {
      await assert.rejects(store.get(bad), UsageError, bad);
    }
    await assert.rejects(store.get('0123456789ab'), UsageError); // valido ma inesistente
  });
});

test('list filtra per stato, ordina per creazione e segnala i file corrotti', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await store.add('a', new Date('2026-10-08T10:00:00Z'));
    const b = await store.add('b', new Date('2026-10-08T09:00:00Z'));
    await writeFile(join(dir, 'deadbeef0000.json'), '{ rotto');
    await writeFile(join(dir, 'altro.txt'), 'ignorato');
    const { notes, corrupt } = await store.list();
    assert.deepEqual(notes.map((n) => n.id), [b.id, a.id]);
    assert.deepEqual(corrupt, ['deadbeef0000.json']);
    await store.schedule(a.id, new Date('2026-10-09T10:00:00Z'), NOW);
    assert.deepEqual((await store.list('scheduled')).notes.map((n) => n.id), [a.id]);
  });
});

test('schedule richiede una data futura; unschedule torna a draft', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await assert.rejects(store.schedule(n.id, new Date('2026-10-08T09:00:00Z'), NOW), UsageError);
    const s = await store.schedule(n.id, new Date('2026-10-09T10:00:00Z'), NOW);
    assert.equal(s.status, 'scheduled');
    assert.equal(s.publishAt, '2026-10-09T10:00:00.000Z');
    const back = await store.unschedule(n.id);
    assert.equal(back.status, 'draft');
    assert.equal(back.publishAt, undefined);
    await assert.rejects(store.unschedule(n.id), StateError);
  });
});

test('transizioni di pubblicazione: begin → complete', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    const p = await store.beginPublish(n.id);
    assert.equal(p.status, 'publishing');
    assert.equal(p.prevStatus, 'draft');
    await assert.rejects(store.beginPublish(n.id), StateError); // già in corso
    const done = await store.completePublish(n.id, 'note-9', NOW);
    assert.equal(done.status, 'published');
    assert.equal(done.substackId, 'note-9');
    assert.equal(done.publishedAt, NOW.toISOString());
    await assert.rejects(store.beginPublish(n.id), StateError); // già pubblicata
  });
});

test('revert torna allo stato precedente; fail e markUncertain annotano l\'errore', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await store.schedule(n.id, new Date('2026-10-09T10:00:00Z'), NOW);
    await store.beginPublish(n.id);
    const r = await store.revert(n.id, 'cookie scaduto');
    assert.equal(r.status, 'scheduled');
    assert.equal(r.error, 'cookie scaduto');
    await store.beginPublish(n.id);
    const u = await store.markUncertain(n.id, 'timeout');
    assert.equal(u.status, 'publishing');
    assert.equal(u.error, 'timeout');
    await store.resolve(n.id, 'retry', NOW);
    await store.beginPublish(n.id);
    const f = await store.fail(n.id, 'rifiutata');
    assert.equal(f.status, 'failed');
    assert.equal(f.error, 'rifiutata');
  });
});

test('resolve: --published segna come pubblicata, --retry torna indietro; solo da publishing', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await store.add('a', NOW);
    await assert.rejects(store.resolve(a.id, 'retry', NOW), StateError);
    await store.beginPublish(a.id);
    const pub = await store.resolve(a.id, 'published', NOW);
    assert.equal(pub.status, 'published');
    assert.equal(pub.publishedAt, NOW.toISOString());
    const b = await store.add('b', NOW);
    await store.beginPublish(b.id);
    assert.equal((await store.resolve(b.id, 'retry', NOW)).status, 'draft');
  });
});

test('un file modificato a mano con stato non valido viene segnalato', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('x', NOW);
    await writeFile(join(dir, `${n.id}.json`), JSON.stringify({ ...n, status: 'boh' }));
    await assert.rejects(store.get(n.id), StateError);
  });
});
```

Run: `node --test tests/unit/notes/store.test.ts` → FAIL.

- [ ] **Step 2: Implementa `store.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { markdownToDoc } from '../markdown/prosemirror.ts';
import { StateError, UsageError } from '../util/errors.ts';
import { atomicWriteFile } from '../util/fs.ts';

const STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed'] as const;
export type NoteStatus = (typeof STATUSES)[number];

const NoteSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{12}$/),
    text: z.string().min(1).max(5000),
    status: z.enum(STATUSES),
    createdAt: z.string(),
    publishAt: z.string().optional(),
    prevStatus: z.enum(['draft', 'scheduled']).optional(),
    publishedAt: z.string().optional(),
    substackId: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

export type Note = z.infer<typeof NoteSchema>;

const ID_RE = /^[0-9a-f]{12}$/;

export class NoteStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get lockPath(): string {
    return join(this.dir, '.lock');
  }

  private path(id: string): string {
    if (!ID_RE.test(id)) throw new UsageError(`Id nota non valido: "${id}"`);
    return join(this.dir, `${id}.json`);
  }

  private async write(note: Note): Promise<Note> {
    await atomicWriteFile(this.path(note.id), JSON.stringify(note, null, 2) + '\n');
    return note;
  }

  async add(text: string, now: Date): Promise<Note> {
    if (text.length > 5000) throw new UsageError('La nota supera i 5000 caratteri');
    markdownToDoc(text); // valida subito: errori di Markdown emergono qui, non alla pubblicazione
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = randomBytes(6).toString('hex');
    return this.write({ id, text, status: 'draft', createdAt: now.toISOString() });
  }

  async get(id: string): Promise<Note> {
    const path = this.path(id);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new UsageError(`Nota non trovata: ${id}`);
      throw e;
    }
    try {
      return NoteSchema.parse(JSON.parse(raw));
    } catch {
      throw new StateError(`File nota corrotto o modificato in modo non valido: ${path}`);
    }
  }

  async list(status?: NoteStatus): Promise<{ notes: Note[]; corrupt: string[] }> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const notes: Note[] = [];
    const corrupt: string[] = [];
    for (const name of names.filter((n) => /^[0-9a-f]{12}\.json$/.test(n))) {
      try {
        notes.push(await this.get(name.slice(0, -5)));
      } catch {
        corrupt.push(name);
      }
    }
    notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { notes: status ? notes.filter((n) => n.status === status) : notes, corrupt };
  }

  private async transition(id: string, from: NoteStatus[], change: (n: Note) => Note): Promise<Note> {
    const note = await this.get(id);
    if (!from.includes(note.status)) {
      throw new StateError(`Nota ${id}: operazione non consentita dallo stato "${note.status}"`);
    }
    return this.write(change(note));
  }

  async schedule(id: string, at: Date, now: Date): Promise<Note> {
    if (at.getTime() <= now.getTime()) throw new UsageError('La data di pubblicazione deve essere nel futuro');
    return this.transition(id, ['draft', 'scheduled'], (n) => {
      const { error: _e, ...rest } = n;
      return { ...rest, status: 'scheduled', publishAt: at.toISOString() };
    });
  }

  async unschedule(id: string): Promise<Note> {
    return this.transition(id, ['scheduled'], (n) => {
      const { publishAt: _p, error: _e, ...rest } = n;
      return { ...rest, status: 'draft' };
    });
  }

  async beginPublish(id: string): Promise<Note> {
    return this.transition(id, ['draft', 'scheduled'], (n) => {
      const { error: _e, ...rest } = n;
      return { ...rest, status: 'publishing', prevStatus: n.status as 'draft' | 'scheduled' };
    });
  }

  async completePublish(id: string, substackId: string, now: Date): Promise<Note> {
    return this.transition(id, ['publishing'], (n) => {
      const { prevStatus: _p, error: _e, ...rest } = n;
      return { ...rest, status: 'published', substackId, publishedAt: now.toISOString() };
    });
  }

  async revert(id: string, error: string): Promise<Note> {
    return this.transition(id, ['publishing'], (n) => {
      const { prevStatus, ...rest } = n;
      return { ...rest, status: prevStatus ?? 'draft', error };
    });
  }

  async fail(id: string, error: string): Promise<Note> {
    return this.transition(id, ['publishing'], (n) => {
      const { prevStatus: _p, ...rest } = n;
      return { ...rest, status: 'failed', error };
    });
  }

  async markUncertain(id: string, error: string): Promise<Note> {
    return this.transition(id, ['publishing'], (n) => ({ ...n, error }));
  }

  async resolve(id: string, how: 'published' | 'retry', now: Date): Promise<Note> {
    return this.transition(id, ['publishing'], (n) => {
      const { prevStatus, error: _e, ...rest } = n;
      if (how === 'published') return { ...rest, status: 'published', publishedAt: now.toISOString() };
      return { ...rest, status: prevStatus ?? 'draft' };
    });
  }
}
```

- [ ] **Step 3: Esegui i test dello store**

Run: `node --test tests/unit/notes/store.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Test di `publishOne`/`runDue` (falliscono)**

`tests/unit/notes/publish.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoteStore } from '../../../src/notes/store.ts';
import { classifyPublishError, publishOne, runDue } from '../../../src/notes/publish.ts';
import { ApiShapeError, AuthError, NetworkError, RateLimitError, UsageError } from '../../../src/util/errors.ts';
import { withTmpDir } from '../../helpers/tmp.ts';
import type { PMDoc } from '../../../src/markdown/prosemirror.ts';

const T0 = new Date('2026-10-08T10:00:00Z');
const DUE = new Date('2026-10-08T12:00:00Z');
const AFTER = new Date('2026-10-08T12:00:01Z');

async function scheduled(store: NoteStore, text: string, at = DUE) {
  const n = await store.add(text, T0);
  await store.schedule(n.id, at, T0);
  return n;
}

test('classifyPublishError', () => {
  assert.equal(classifyPublishError(new AuthError('x')), 'revert');
  assert.equal(classifyPublishError(new RateLimitError('x')), 'revert');
  assert.equal(classifyPublishError(new UsageError('x')), 'fail');
  assert.equal(classifyPublishError(new ApiShapeError('x', 400)), 'fail');
  assert.equal(classifyPublishError(new ApiShapeError('x', 499)), 'fail');
  assert.equal(classifyPublishError(new ApiShapeError('x', 200)), 'uncertain');
  assert.equal(classifyPublishError(new ApiShapeError('x')), 'uncertain');
  assert.equal(classifyPublishError(new NetworkError('x')), 'uncertain');
  assert.equal(classifyPublishError(new Error('boh')), 'uncertain');
});

test('runDue pubblica solo le note scadute, in ordine di publishAt', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const late = await scheduled(store, 'tardi', new Date('2026-10-08T11:00:00Z'));
    const early = await scheduled(store, 'presto', new Date('2026-10-08T10:30:00Z'));
    const future = await scheduled(store, 'futura', new Date('2026-10-09T10:00:00Z'));
    const draft = await store.add('bozza', T0);
    const posted: PMDoc[] = [];
    const r = await runDue(store, async (doc) => { posted.push(doc); return { id: `n${posted.length}` }; }, DUE);
    assert.deepEqual(r.published, [early.id, late.id]);
    assert.equal(posted.length, 2);
    assert.equal((await store.get(future.id)).status, 'scheduled');
    assert.equal((await store.get(draft.id)).status, 'draft');
    assert.equal((await store.get(early.id)).substackId, 'n1');
  });
});

test('runDue è idempotente: una seconda esecuzione non ripubblica', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'x');
    let calls = 0;
    const post = async () => { calls++; return { id: 'n' }; };
    await runDue(store, post, AFTER);
    const second = await runDue(store, post, AFTER);
    assert.equal(calls, 1);
    assert.deepEqual(second.published, []);
  });
});

test('AuthError: la nota torna schedulata, il ciclo si ferma e authFailed è true', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const a = await scheduled(store, 'a', new Date('2026-10-08T10:30:00Z'));
    const b = await scheduled(store, 'b', new Date('2026-10-08T10:40:00Z'));
    let calls = 0;
    const r = await runDue(store, async () => { calls++; throw new AuthError('scaduto'); }, DUE);
    assert.equal(calls, 1);
    assert.equal(r.authFailed, true);
    assert.equal((await store.get(a.id)).status, 'scheduled');
    assert.match((await store.get(a.id)).error ?? '', /scaduto/);
    assert.equal((await store.get(b.id)).status, 'scheduled');
    assert.deepEqual(r.reverted.map((x) => x.id), [a.id]);
  });
});

test('errore di rete: la nota resta in publishing e non viene mai ripubblicata', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await scheduled(store, 'x');
    const r1 = await runDue(store, async () => { throw new NetworkError('timeout'); }, AFTER);
    assert.deepEqual(r1.uncertain.map((x) => x.id), [n.id]);
    assert.equal((await store.get(n.id)).status, 'publishing');
    let calls = 0;
    const r2 = await runDue(store, async () => { calls++; return { id: 'n' }; }, AFTER);
    assert.equal(calls, 0);
    assert.deepEqual(r2.stuck, [n.id]);
    assert.deepEqual(r2.published, []);
  });
});

test('rifiuto definitivo (400): la nota passa a failed e le altre proseguono', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const bad = await scheduled(store, 'rifiutata', new Date('2026-10-08T10:30:00Z'));
    const ok = await scheduled(store, 'ok', new Date('2026-10-08T10:40:00Z'));
    let n = 0;
    const r = await runDue(store, async () => {
      if (++n === 1) throw new ApiShapeError('400', 400);
      return { id: 'z' };
    }, DUE);
    assert.deepEqual(r.failed.map((x) => x.id), [bad.id]);
    assert.deepEqual(r.published, [ok.id]);
    assert.equal((await store.get(bad.id)).status, 'failed');
  });
});

test('rate limit: ripristina e interrompe', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'a', new Date('2026-10-08T10:30:00Z'));
    await scheduled(store, 'b', new Date('2026-10-08T10:40:00Z'));
    let calls = 0;
    const r = await runDue(store, async () => { calls++; throw new RateLimitError('429'); }, DUE);
    assert.equal(calls, 1);
    assert.equal(r.reverted.length, 1);
    assert.equal(r.authFailed, false);
  });
});

test('runDue segnala i file corrotti senza fermarsi', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'x');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${dir}/deadbeef0000.json`, 'rotto');
    const r = await runDue(store, async () => ({ id: 'n' }), AFTER);
    assert.equal(r.published.length, 1);
    assert.deepEqual(r.corrupt, ['deadbeef0000.json']);
  });
});

test('due runDue concorrenti: il secondo fallisce per il lock (StateError)', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    await scheduled(store, 'x');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = runDue(store, async () => { await gate; return { id: 'n' }; }, AFTER);
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(runDue(store, async () => ({ id: 'm' }), AFTER), /in corso/);
    release();
    assert.equal((await first).published.length, 1);
  });
});

test('publishOne su nota draft pubblica subito e restituisce l\'esito', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    const n = await store.add('ciao', T0);
    const out = await publishOne(store, n.id, async () => ({ id: 'abc' }), T0);
    assert.deepEqual(out, { kind: 'published', substackId: 'abc' });
    const n2 = await store.add('ciao2', T0);
    const bad = await publishOne(store, n2.id, async () => { throw new NetworkError('x'); }, T0);
    assert.equal(bad.kind, 'uncertain');
  });
});
```

Run: `node --test tests/unit/notes/publish.test.ts` → FAIL.

- [ ] **Step 5: Implementa `publish.ts`**

```ts
import { markdownToDoc } from '../markdown/prosemirror.ts';
import type { PMDoc } from '../markdown/prosemirror.ts';
import { ApiShapeError, AuthError, RateLimitError, UsageError } from '../util/errors.ts';
import { withLock } from '../util/fs.ts';
import type { NoteStore } from './store.ts';

export type PostNote = (doc: PMDoc) => Promise<{ id: string }>;
export type ErrorClass = 'revert' | 'fail' | 'uncertain';

export function classifyPublishError(e: unknown): ErrorClass {
  if (e instanceof AuthError || e instanceof RateLimitError) return 'revert';
  if (e instanceof UsageError) return 'fail';
  if (e instanceof ApiShapeError && e.httpStatus !== undefined && e.httpStatus >= 400 && e.httpStatus < 500) return 'fail';
  return 'uncertain';
}

export type Outcome =
  | { kind: 'published'; substackId: string }
  | { kind: 'reverted' | 'failed' | 'uncertain'; error: Error };

export async function publishOne(store: NoteStore, id: string, post: PostNote, now: Date): Promise<Outcome> {
  const note = await store.beginPublish(id);
  try {
    const result = await post(markdownToDoc(note.text));
    await store.completePublish(id, result.id, now);
    return { kind: 'published', substackId: result.id };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    switch (classifyPublishError(e)) {
      case 'revert':
        await store.revert(id, error.message);
        return { kind: 'reverted', error };
      case 'fail':
        await store.fail(id, error.message);
        return { kind: 'failed', error };
      default:
        await store.markUncertain(id, error.message);
        return { kind: 'uncertain', error };
    }
  }
}

export interface RunDueResult {
  published: string[];
  reverted: { id: string; error: string }[];
  failed: { id: string; error: string }[];
  uncertain: { id: string; error: string }[];
  stuck: string[];
  corrupt: string[];
  authFailed: boolean;
}

export async function runDue(store: NoteStore, post: PostNote, now: Date): Promise<RunDueResult> {
  return withLock(store.lockPath, async () => {
    const result: RunDueResult = {
      published: [], reverted: [], failed: [], uncertain: [], stuck: [], corrupt: [], authFailed: false,
    };
    const { notes, corrupt } = await store.list();
    result.corrupt = corrupt;
    result.stuck = notes.filter((n) => n.status === 'publishing').map((n) => n.id);
    const due = notes
      .filter((n) => n.status === 'scheduled' && n.publishAt !== undefined && new Date(n.publishAt).getTime() <= now.getTime())
      .sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? ''));
    for (const n of due) {
      const out = await publishOne(store, n.id, post, now);
      if (out.kind === 'published') {
        result.published.push(n.id);
        continue;
      }
      const entry = { id: n.id, error: out.error.message };
      if (out.kind === 'failed') result.failed.push(entry);
      else if (out.kind === 'uncertain') result.uncertain.push(entry);
      else {
        result.reverted.push(entry);
        result.authFailed = out.error instanceof AuthError;
        break; // cookie scaduto o rate limit: inutile insistere con le altre
      }
    }
    return result;
  });
}
```

- [ ] **Step 6: Esegui i test e commit**

Run: `node --test "tests/unit/notes/*.test.ts" && npm run typecheck`
Expected: PASS.

```bash
git add -A && git commit -m "feat(notes): coda locale con macchina a stati e run-due idempotente" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Provider LLM e generazione

**Files:**
- Create: `src/generate/provider.ts`, `src/generate/anthropic.ts`, `src/generate/openai-compat.ts`, `src/generate/generate.ts`, `tests/unit/generate/providers.test.ts`, `tests/unit/generate/generate.test.ts`

- [ ] **Step 1: Test dei provider (falliscono)**

`tests/unit/generate/providers.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicProvider } from '../../../src/generate/anthropic.ts';
import { openaiCompatProvider } from '../../../src/generate/openai-compat.ts';
import { ProviderError } from '../../../src/util/errors.ts';
import { json, makeFetch } from '../../helpers/fetch.ts';
import type { Call } from '../../helpers/fetch.ts';

const REQ = { system: 'sys', prompt: 'ciao', maxTokens: 100 };

test('anthropic: richiesta Messages API e testo estratto', async () => {
  const calls: Call[] = [];
  const p = anthropicProvider({
    apiKey: 'sk-ant-test-key-1234', model: 'claude-sonnet-5-5', timeoutMs: 5000,
    fetchImpl: makeFetch(() => json({ content: [{ type: 'text', text: 'Risposta' }] }), calls),
  });
  assert.equal(await p.generate(REQ), 'Risposta');
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');
  const h = new Headers(calls[0]!.init.headers);
  assert.equal(h.get('x-api-key'), 'sk-ant-test-key-1234');
  assert.equal(h.get('anthropic-version'), '2023-06-01');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body, { model: 'claude-sonnet-5-5', max_tokens: 100, system: 'sys', messages: [{ role: 'user', content: 'ciao' }] });
  assert.equal(calls[0]!.init.redirect, 'error');
});

test('anthropic: errori HTTP e forma errata → ProviderError senza chiave nel messaggio', async () => {
  const mk = (route: () => Response) => anthropicProvider({
    apiKey: 'sk-ant-test-key-1234', model: 'm', timeoutMs: 5000, fetchImpl: makeFetch(route),
  });
  await assert.rejects(mk(() => json({ error: { message: 'sk-ant-test-key-1234 invalida' } }, 401)).generate(REQ),
    (e: Error) => e instanceof ProviderError && !e.message.includes('sk-ant-test-key-1234'));
  await assert.rejects(mk(() => json({ content: [] })).generate(REQ), ProviderError);
  await assert.rejects(mk(() => new Response('non json')).generate(REQ), ProviderError);
});

test('openai-compat: URL, header opzionale, testo estratto', async () => {
  const calls: Call[] = [];
  const p = openaiCompatProvider({
    baseUrl: 'http://llm.local:8080/', model: 'qwen', apiKey: 'k-1234567890', timeoutMs: 5000,
    fetchImpl: makeFetch(() => json({ choices: [{ message: { content: 'Testo' } }] }), calls),
  });
  assert.equal(await p.generate(REQ), 'Testo');
  assert.equal(calls[0]!.url, 'http://llm.local:8080/v1/chat/completions');
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer k-1234567890');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.deepEqual(body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'ciao' }]);
  assert.equal(body.model, 'qwen');
  assert.equal(body.max_tokens, 100);
});

test('openai-compat senza apiKey: nessun header authorization; errori → ProviderError', async () => {
  const calls: Call[] = [];
  const p = openaiCompatProvider({
    baseUrl: 'http://llm.local', model: 'm', timeoutMs: 5000,
    fetchImpl: makeFetch(() => json({ choices: [{ message: { content: 'x' } }] }), calls),
  });
  await p.generate(REQ);
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), null);
  const bad = openaiCompatProvider({ baseUrl: 'http://llm.local', model: 'm', timeoutMs: 5000, fetchImpl: makeFetch(() => json({ choices: [] })) });
  await assert.rejects(bad.generate(REQ), ProviderError);
  const down = openaiCompatProvider({ baseUrl: 'http://llm.local', model: 'm', timeoutMs: 5000, fetchImpl: makeFetch(() => { throw new Error('ECONNREFUSED'); }) });
  await assert.rejects(down.generate(REQ), /ECONNREFUSED/);
});
```

Run: `node --test tests/unit/generate/providers.test.ts` → FAIL.

- [ ] **Step 2: Implementa i provider**

`src/generate/provider.ts`:

```ts
export interface GenerateRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface Provider {
  generate(req: GenerateRequest): Promise<string>;
}
```

`src/generate/anthropic.ts`:

```ts
import { z } from 'zod';
import { ProviderError } from '../util/errors.ts';
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
      let data: unknown;
      try {
        data = await res.json();
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
```

`src/generate/openai-compat.ts`:

```ts
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
```

- [ ] **Step 3: Test di `generate.ts` (falliscono)**

`tests/unit/generate/generate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMarkdown, generateArticle, generateNote, InvalidOutputError, slugify } from '../../../src/generate/generate.ts';
import type { Provider } from '../../../src/generate/provider.ts';

const stub = (text: string, seen: { prompt?: string; system?: string } = {}): Provider => ({
  async generate(req) { seen.prompt = req.prompt; seen.system = req.system; return text; },
});

test('extractMarkdown toglie il recinto ```markdown e gli spazi', () => {
  assert.equal(extractMarkdown('```markdown\n# Ciao\n```\n'), '# Ciao');
  assert.equal(extractMarkdown('```md\nA\n```'), 'A');
  assert.equal(extractMarkdown('  testo normale \n'), 'testo normale');
  assert.equal(extractMarkdown('```js\ncodice\n```'), '```js\ncodice\n```'); // un blocco di codice vero resta
});

test('generateArticle: prompt con argomento e lingua, output validato', async () => {
  const seen: { prompt?: string; system?: string } = {};
  const out = '---\ntitle: Titolo\n---\n\nCorpo.';
  const r = await generateArticle(stub(out, seen), { topic: 'Rust', lang: 'it', maxTokens: 500 });
  assert.equal(r.article.frontMatter.title, 'Titolo');
  assert.equal(r.markdown, out);
  assert.match(seen.prompt ?? '', /Rust/);
  assert.match(seen.prompt ?? '', /it/);
  assert.match(seen.system ?? '', /front-matter/i);
});

test('generateArticle: output non valido → InvalidOutputError con il testo grezzo', async () => {
  await assert.rejects(
    generateArticle(stub('Nessun front-matter'), { topic: 't', lang: 'it', maxTokens: 10 }),
    (e: Error) => e instanceof InvalidOutputError && e.raw === 'Nessun front-matter',
  );
  await assert.rejects(
    generateArticle(stub('---\ntitle: T\n---\n\n<script>x</script>'), { topic: 't', lang: 'it', maxTokens: 10 }),
    InvalidOutputError,
  );
});

test('generateNote: testo validato come Markdown', async () => {
  assert.equal(await generateNote(stub('Una nota **breve**'), { topic: 't', lang: 'it', maxTokens: 10 }), 'Una nota **breve**');
  await assert.rejects(generateNote(stub('<b>no</b>'), { topic: 't', lang: 'it', maxTokens: 10 }), InvalidOutputError);
  await assert.rejects(generateNote(stub('x'.repeat(5001)), { topic: 't', lang: 'it', maxTokens: 10 }), InvalidOutputError);
});

test('slugify produce nomi file sicuri', () => {
  assert.equal(slugify('Ciao Mondo! È già così?'), 'ciao-mondo-e-gia-cosi');
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugify('!!!'), 'bozza');
  assert.equal(slugify('a'.repeat(200)).length, 60);
});
```

Run: `node --test tests/unit/generate/generate.test.ts` → FAIL.

- [ ] **Step 4: Implementa `generate.ts`**

```ts
import { parseArticle } from '../markdown/frontmatter.ts';
import type { ParsedArticle } from '../markdown/frontmatter.ts';
import { markdownToDoc } from '../markdown/prosemirror.ts';
import { ProviderError } from '../util/errors.ts';
import type { Provider } from './provider.ts';

export class InvalidOutputError extends ProviderError {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.raw = raw;
  }
}

export interface GenerateOptions {
  topic: string;
  lang: string;
  maxTokens: number;
}

const ARTICLE_SYSTEM = `Sei un redattore di newsletter. Rispondi SOLO con un documento Markdown.
Il documento inizia con un front-matter YAML (--- title: ... subtitle: ... ---) seguito dal corpo.
Nel corpo usa solo: titoli ## e ###, paragrafi, **grassetto**, *corsivo*, liste, citazioni, link https, blocchi di codice.
Non usare HTML, tabelle, task list, immagini inline né testo fuori dal documento.`;

const NOTE_SYSTEM = `Scrivi una nota breve (massimo 600 caratteri) per un social di newsletter.
Rispondi SOLO con il testo della nota, in Markdown semplice (paragrafi, **grassetto**, *corsivo*, link https). Niente HTML.`;

export function extractMarkdown(raw: string): string {
  const text = raw.trim();
  const m = /^```(?:markdown|md)\n([\s\S]*?)\n```$/.exec(text);
  return m ? (m[1] ?? '').trim() : text;
}

export async function generateArticle(
  provider: Provider, opts: GenerateOptions,
): Promise<{ markdown: string; article: ParsedArticle }> {
  const raw = await provider.generate({
    system: ARTICLE_SYSTEM,
    prompt: `Scrivi un articolo in lingua "${opts.lang}" sul tema: ${opts.topic}`,
    maxTokens: opts.maxTokens,
  });
  const markdown = extractMarkdown(raw);
  try {
    return { markdown, article: parseArticle(markdown) };
  } catch (e) {
    throw new InvalidOutputError(`L'output generato non è un articolo valido: ${(e as Error).message}`, raw);
  }
}

export async function generateNote(provider: Provider, opts: GenerateOptions): Promise<string> {
  const raw = await provider.generate({
    system: NOTE_SYSTEM,
    prompt: `Scrivi una nota in lingua "${opts.lang}" sul tema: ${opts.topic}`,
    maxTokens: opts.maxTokens,
  });
  const text = extractMarkdown(raw);
  try {
    if (text.length > 5000) throw new Error('la nota supera i 5000 caratteri');
    markdownToDoc(text);
  } catch (e) {
    throw new InvalidOutputError(`L'output generato non è una nota valida: ${(e as Error).message}`, raw);
  }
  return text;
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'bozza';
}
```

- [ ] **Step 5: Esegui i test e commit**

Run: `node --test "tests/unit/generate/*.test.ts" && npm run typecheck`
Expected: PASS.

```bash
git add -A && git commit -m "feat(generate): provider Anthropic e OpenAI-compatibile, validazione dell'output" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: CLI (contesto, router, comandi)

**Files:**
- Create: `src/cli/context.ts`, `src/cli/router.ts`, `src/cli/shared.ts`, `src/cli/commands/{auth,article,note,generate,config}.ts`, `src/cli/main.ts`, `src/auth/login.ts`, `tests/helpers/context.ts`, `tests/unit/cli/router.test.ts`

- [ ] **Step 1: Contesto e comando type**

`src/cli/context.ts`:

```ts
import { createInterface } from 'node:readline/promises';
import { currentTime } from '../util/clock.ts';
import { UsageError } from '../util/errors.ts';
import { redact } from '../util/redact.ts';

export interface Ctx {
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
  isInteractive: boolean;
  prompt(question: string, opts?: { hidden?: boolean }): Promise<string>;
  now(): Date;
  fetchImpl: typeof fetch;
}

const MAX_STDIN = 2_000_000;

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > MAX_STDIN) throw new UsageError('Input da stdin troppo grande (max 2 MB)');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function promptHidden(question: string): Promise<string> {
  process.stderr.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (c === '\u0003') {
          cleanup();
          reject(new UsageError('Interrotto'));
          return;
        }
        buf = c === '\u007f' || c === '\b' ? buf.slice(0, -1) : buf + c;
      }
    };
    stdin.on('data', onData);
  });
}

export function createContext(): Ctx {
  const env = process.env;
  return {
    env,
    out: (text) => { process.stdout.write(redact(text) + '\n'); },
    err: (text) => { process.stderr.write(redact(text) + '\n'); },
    readStdin: readAllStdin,
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: async (question, opts) => {
      if (opts?.hidden) return promptHidden(question);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    now: () => currentTime(env),
    fetchImpl: fetch,
  };
}
```

`src/cli/shared.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';
import { getSid } from '../auth/store.ts';
import { globalUrl, loadConfig, publicationUrl } from '../config/config.ts';
import { SubstackClient } from '../substack/client.ts';
import { UsageError } from '../util/errors.ts';
import type { Ctx } from './context.ts';

export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface Command {
  path: string;
  summary: string;
  options: Record<string, { type: 'boolean' | 'string' }>;
  run(ctx: Ctx, args: { values: Values; positionals: string[] }): Promise<number>;
}

export const MAX_INPUT_BYTES = 1_000_000;

export function str(values: Values, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
}

export function flag(values: Values, key: string): boolean {
  return values[key] === true;
}

export function emit(ctx: Ctx, values: Values, data: unknown, human: string): void {
  ctx.out(flag(values, 'json') ? JSON.stringify(data) : human);
}

export async function makeClient(ctx: Ctx): Promise<SubstackClient> {
  const config = await loadConfig(ctx.env);
  const sid = await getSid(ctx.env);
  return new SubstackClient({
    sid,
    publicationUrl: publicationUrl(config),
    globalUrl: globalUrl(config),
    fetchImpl: ctx.fetchImpl,
  });
}

export async function readSource(ctx: Ctx, source: string): Promise<string> {
  if (source === '-') return ctx.readStdin();
  const st = await stat(source).catch(() => undefined);
  if (!st || !st.isFile()) throw new UsageError(`File non trovato: ${source}`);
  if (st.size > MAX_INPUT_BYTES) throw new UsageError('File troppo grande (max 1 MB)');
  return readFile(source, 'utf8');
}
```

`tests/helpers/context.ts`:

```ts
import type { Ctx } from '../../src/cli/context.ts';

export interface TestCtx extends Ctx { stdout: string[]; stderr: string[] }

export function testContext(overrides: Partial<Ctx> = {}): TestCtx {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    env: {},
    out: (t) => { stdout.push(t); },
    err: (t) => { stderr.push(t); },
    readStdin: async () => '',
    isInteractive: false,
    prompt: async () => '',
    now: () => new Date('2026-10-08T10:00:00Z'),
    fetchImpl: (async () => { throw new Error('rete non consentita nei test'); }) as typeof fetch,
    ...overrides,
    stdout,
    stderr,
  };
}
```

- [ ] **Step 2: Router e test**

`tests/unit/cli/router.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../../src/cli/router.ts';
import { AuthError } from '../../../src/util/errors.ts';
import { registerSecret } from '../../../src/util/redact.ts';
import { testContext } from '../../helpers/context.ts';

test('help e nessun argomento stampano l\'elenco dei comandi ed escono con 0', async () => {
  for (const argv of [[], ['help'], ['--help']]) {
    const ctx = testContext();
    assert.equal(await run(argv, ctx), 0);
    const text = ctx.stdout.join('\n');
    for (const cmd of ['auth guide', 'article draft', 'article publish', 'note add', 'notes run-due', 'generate article']) {
      assert.match(text, new RegExp(cmd));
    }
  }
});

test('comando sconosciuto → 64', async () => {
  const ctx = testContext();
  assert.equal(await run(['foo', 'bar'], ctx), 64);
  assert.match(ctx.stderr.join('\n'), /sconosciuto/);
  assert.equal(await run(['article'], testContext()), 64);
});

test('opzione sconosciuta → 64', async () => {
  const ctx = testContext();
  assert.equal(await run(['auth', 'guide', '--boh'], ctx), 64);
});

test('auth guide stampa la guida', async () => {
  const ctx = testContext();
  assert.equal(await run(['auth', 'guide'], ctx), 0);
  assert.match(ctx.stdout.join('\n'), /substack\.sid/);
});

test('gli errori tipizzati diventano exit code e messaggio su stderr, senza segreti', async () => {
  registerSecret('super-secret-value-123');
  const ctx = testContext({
    env: { SUBSTACK_CLI_CONFIG_DIR: '/nonexistent-dir-xyz' },
    fetchImpl: (async () => { throw new AuthError('token super-secret-value-123 scaduto'); }) as typeof fetch,
  });
  const code = await run(['auth', 'check'], ctx);
  assert.equal(code, 2); // cookie non configurato → AuthError
  assert.ok(!ctx.stderr.join('\n').includes('super-secret-value-123'));
});
```

`src/cli/router.ts`:

```ts
import { parseArgs } from 'node:util';
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
```

`src/cli/main.ts`:

```ts
#!/usr/bin/env node
import { createContext } from './context.ts';
import { run } from './router.ts';

process.exitCode = await run(process.argv.slice(2), createContext());
```

- [ ] **Step 3: Comandi `auth` e login Playwright**

`src/auth/login.ts`:

```ts
import { UsageError } from '../util/errors.ts';

interface PwPage { goto(url: string): Promise<unknown> }
interface PwContext { newPage(): Promise<PwPage>; cookies(url: string): Promise<{ name: string; value: string }[]> }
interface PwBrowser { newContext(): Promise<PwContext>; close(): Promise<void> }
interface Playwright { chromium: { launch(opts: { headless: boolean }): Promise<PwBrowser> } }

export async function browserLogin(timeoutMs = 5 * 60_000): Promise<string> {
  const moduleName = 'playwright'; // nome in variabile: non è una dipendenza del progetto
  let pw: Playwright;
  try {
    pw = (await import(moduleName)) as Playwright;
  } catch {
    throw new UsageError(
      'Playwright non è installato. Sul tuo PC esegui: npm install --no-save playwright && npx playwright install chromium, poi riprova.',
    );
  }
  const browser = await pw.chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://substack.com/sign-in');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cookie = (await context.cookies('https://substack.com')).find((c) => c.name === 'substack.sid');
      if (cookie) return cookie.value;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new UsageError('Tempo scaduto in attesa del login');
  } finally {
    await browser.close();
  }
}
```

`src/cli/commands/auth.ts`:

```ts
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
      const raw = ctx.isInteractive ? await ctx.prompt('Incolla il valore di substack.sid (non verrà mostrato): ', { hidden: true }) : await ctx.readStdin();
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
```

- [ ] **Step 4: Comandi `article`**

`src/cli/commands/article.ts`:

```ts
import { parseArticle } from '../../markdown/frontmatter.ts';
import { parseDraftId } from '../../substack/client.ts';
import { parseFutureInstant } from '../../util/clock.ts';
import { UsageError } from '../../util/errors.ts';
import { emit, flag, makeClient, readSource, str } from '../shared.ts';
import type { Command } from '../shared.ts';

export const articleCommands: Command[] = [
  {
    path: 'article draft',
    summary: 'Crea una bozza online da un file Markdown (o - per stdin)',
    options: { 'dry-run': { type: 'boolean' } },
    async run(ctx, { values, positionals }) {
      const source = positionals[0];
      if (!source) throw new UsageError('Uso: substack article draft <file|-> [--dry-run]');
      const { frontMatter, doc } = parseArticle(await readSource(ctx, source));
      if (flag(values, 'dry-run')) {
        emit(ctx, values,
          { dryRun: true, title: frontMatter.title, subtitle: frontMatter.subtitle ?? null, blocks: doc.content.length },
          `[dry-run] Bozza "${frontMatter.title}" (${doc.content.length} blocchi): nessuna richiesta inviata`);
        return 0;
      }
      const client = await makeClient(ctx);
      const profile = await client.getProfile();
      const draft = await client.createDraft({
        title: frontMatter.title, subtitle: frontMatter.subtitle, body: doc, authorId: profile.id,
      });
      emit(ctx, values, { id: draft.id, url: draft.url }, `Bozza creata: id ${draft.id}\nModifica: ${draft.url}`);
      return 0;
    },
  },
  {
    path: 'article list',
    summary: 'Elenca le bozze più recenti',
    options: {},
    async run(ctx, { values }) {
      const drafts = await (await makeClient(ctx)).listDrafts();
      const rows = drafts.map((d) => ({ id: d.id, title: d.draft_title ?? '(senza titolo)' }));
      emit(ctx, values, rows, rows.length ? rows.map((r) => `${r.id}\t${r.title}`).join('\n') : 'Nessuna bozza.');
      return 0;
    },
  },
  {
    path: 'article publish',
    summary: 'Pubblica una bozza (richiede conferma o --yes; email solo con --send-email)',
    options: { yes: { type: 'boolean' }, 'send-email': { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    async run(ctx, { values, positionals }) {
      const id = parseDraftId(positionals[0]);
      const sendEmail = flag(values, 'send-email');
      const dry = flag(values, 'dry-run');
      if (!dry && !flag(values, 'yes') && !ctx.isInteractive) {
        throw new UsageError('Pubblicazione non interattiva: aggiungi --yes per confermare esplicitamente');
      }
      const client = await makeClient(ctx);
      const draft = await client.getDraft(id);
      const title = draft.draft_title ?? '(senza titolo)';
      const summary = `Pubblicazione di "${title}" (id ${id}) — email agli iscritti: ${sendEmail ? 'SÌ' : 'no'}`;
      if (dry) {
        emit(ctx, values, { dryRun: true, id, title, sendEmail }, `[dry-run] ${summary}`);
        return 0;
      }
      if (!flag(values, 'yes')) {
        ctx.err(summary);
        const answer = await ctx.prompt('Scrivi "pubblica" per confermare: ');
        if (answer.trim().toLowerCase() !== 'pubblica') throw new UsageError('Pubblicazione annullata');
      }
      await client.publishDraft(id, { sendEmail });
      emit(ctx, values, { published: true, id, sendEmail }, `Pubblicato: "${title}" (id ${id})`);
      return 0;
    },
  },
  {
    path: 'article schedule',
    summary: 'Schedula (--at <ISO con offset>) o annulla (--cancel) la pubblicazione nativa di Substack',
    options: { at: { type: 'string' }, cancel: { type: 'boolean' }, 'send-email': { type: 'boolean' } },
    async run(ctx, { values, positionals }) {
      const id = parseDraftId(positionals[0]);
      const at = str(values, 'at');
      const cancel = flag(values, 'cancel');
      if ((at === undefined) === !cancel) throw new UsageError('Specifica esattamente una opzione tra --at <data> e --cancel');
      const client = await makeClient(ctx);
      if (cancel) {
        await client.cancelSchedule(id);
        emit(ctx, values, { id, cancelled: true }, `Schedulazione annullata per la bozza ${id}`);
        return 0;
      }
      const when = parseFutureInstant(at as string, ctx.now());
      const sendEmail = flag(values, 'send-email');
      await client.scheduleDraft(id, when, { sendEmail });
      emit(ctx, values, { id, scheduledFor: when.toISOString(), sendEmail },
        `Bozza ${id} schedulata per ${when.toISOString()} (email: ${sendEmail ? 'sì' : 'no'})`);
      return 0;
    },
  },
];
```

- [ ] **Step 5: Comandi `note` e `notes`**

`src/cli/commands/note.ts`:

```ts
import { join } from 'node:path';
import { dataDir, loadConfig } from '../../config/config.ts';
import { NoteStore } from '../../notes/store.ts';
import type { NoteStatus } from '../../notes/store.ts';
import { publishOne, runDue } from '../../notes/publish.ts';
import { parseFutureInstant } from '../../util/clock.ts';
import { StateError, UsageError } from '../../util/errors.ts';
import { withLock } from '../../util/fs.ts';
import type { Ctx } from '../context.ts';
import { emit, flag, makeClient, readSource, str } from '../shared.ts';
import type { Command } from '../shared.ts';

const STATUS_VALUES = ['draft', 'scheduled', 'publishing', 'published', 'failed'];

export function storeFor(ctx: Ctx): NoteStore {
  return new NoteStore(join(dataDir(ctx.env), 'notes'));
}

function requireId(positionals: string[]): string {
  const id = positionals[0];
  if (!id) throw new UsageError('Serve l\'id della nota');
  return id;
}

export const noteCommands: Command[] = [
  {
    path: 'note add',
    summary: 'Aggiunge una nota alla coda locale (testo, oppure - per stdin)',
    options: {},
    async run(ctx, { values, positionals }) {
      const arg = positionals[0];
      if (!arg) throw new UsageError('Uso: substack note add <testo|->');
      const text = arg === '-' ? (await readSource(ctx, '-')).trim() : arg;
      const note = await storeFor(ctx).add(text, ctx.now());
      emit(ctx, values, note, `Nota aggiunta (draft): ${note.id}`);
      return 0;
    },
  },
  {
    path: 'note list',
    summary: 'Elenca le note locali (--status draft|scheduled|publishing|published|failed)',
    options: { status: { type: 'string' } },
    async run(ctx, { values }) {
      const status = str(values, 'status');
      if (status !== undefined && !STATUS_VALUES.includes(status)) throw new UsageError(`Stato non valido: ${status}`);
      const { notes, corrupt } = await storeFor(ctx).list(status as NoteStatus | undefined);
      for (const f of corrupt) ctx.err(`Attenzione: file nota non leggibile: ${f}`);
      const human = notes.length
        ? notes.map((n) => `${n.id}\t${n.status}\t${n.publishAt ?? '-'}\t${n.text.replace(/\s+/g, ' ').slice(0, 60)}`).join('\n')
        : 'Nessuna nota.';
      emit(ctx, values, notes, human);
      return 0;
    },
  },
  {
    path: 'note schedule',
    summary: 'Schedula una nota (--at <ISO con offset>); la pubblica "notes run-due"',
    options: { at: { type: 'string' } },
    async run(ctx, { values, positionals }) {
      const at = str(values, 'at');
      if (!at) throw new UsageError('Uso: substack note schedule <id> --at <data ISO con offset>');
      const when = parseFutureInstant(at, ctx.now());
      const note = await storeFor(ctx).schedule(requireId(positionals), when, ctx.now());
      emit(ctx, values, note, `Nota ${note.id} schedulata per ${note.publishAt}`);
      return 0;
    },
  },
  {
    path: 'note unschedule',
    summary: 'Riporta una nota schedulata allo stato draft',
    options: {},
    async run(ctx, { values, positionals }) {
      const note = await storeFor(ctx).unschedule(requireId(positionals));
      emit(ctx, values, note, `Nota ${note.id} di nuovo in draft`);
      return 0;
    },
  },
  {
    path: 'note publish',
    summary: 'Pubblica subito una nota della coda',
    options: {},
    async run(ctx, { values, positionals }) {
      const id = requireId(positionals);
      const store = storeFor(ctx);
      const client = await makeClient(ctx);
      const outcome = await withLock(store.lockPath, () => publishOne(store, id, (doc) => client.postNote(doc), ctx.now()));
      if (outcome.kind === 'published') {
        emit(ctx, values, { id, substackId: outcome.substackId }, `Nota ${id} pubblicata (id Substack ${outcome.substackId})`);
        return 0;
      }
      if (outcome.kind === 'uncertain') {
        throw new StateError(`Esito incerto per la nota ${id} (${outcome.error.message}). Controlla su Substack e usa "note resolve ${id} --published|--retry".`);
      }
      throw outcome.error;
    },
  },
  {
    path: 'note resolve',
    summary: 'Risolve una nota rimasta in "publishing" (--published | --retry)',
    options: { published: { type: 'boolean' }, retry: { type: 'boolean' } },
    async run(ctx, { values, positionals }) {
      if (flag(values, 'published') === flag(values, 'retry')) throw new UsageError('Specifica esattamente una opzione tra --published e --retry');
      const store = storeFor(ctx);
      const how = flag(values, 'published') ? 'published' : 'retry';
      const note = await withLock(store.lockPath, () => store.resolve(requireId(positionals), how, ctx.now()));
      emit(ctx, values, note, `Nota ${note.id} → ${note.status}`);
      return 0;
    },
  },
  {
    path: 'notes run-due',
    summary: 'Pubblica le note schedulate scadute (per cron/systemd/k3s)',
    options: { 'dry-run': { type: 'boolean' } },
    async run(ctx, { values }) {
      const store = storeFor(ctx);
      if (flag(values, 'dry-run')) {
        const { notes } = await store.list('scheduled');
        const due = notes.filter((n) => n.publishAt !== undefined && new Date(n.publishAt).getTime() <= ctx.now().getTime());
        emit(ctx, values, { dryRun: true, due: due.map((n) => n.id) }, `[dry-run] Note da pubblicare: ${due.length}`);
        return 0;
      }
      await loadConfig(ctx.env); // fallisce subito se la config non è valida
      const client = await makeClient(ctx);
      const r = await runDue(store, (doc) => client.postNote(doc), ctx.now());
      emit(ctx, values, r, [
        `Pubblicate: ${r.published.length}`,
        ...r.reverted.map((x) => `Rimandata ${x.id}: ${x.error}`),
        ...r.failed.map((x) => `Fallita ${x.id}: ${x.error}`),
        ...r.uncertain.map((x) => `INCERTA ${x.id}: ${x.error}`),
        ...r.stuck.map((id) => `BLOCCATA ${id}: in "publishing", serve "note resolve"`),
        ...r.corrupt.map((f) => `File non leggibile: ${f}`),
      ].join('\n'));
      if (r.authFailed) return 2;
      if (r.stuck.length > 0 || r.uncertain.length > 0 || r.failed.length > 0 || r.corrupt.length > 0) return 6;
      return 0;
    },
  },
];
```

- [ ] **Step 6: Comandi `generate` e `config`**

`src/cli/commands/generate.ts`:

```ts
import { join } from 'node:path';
import { getApiKey } from '../../auth/store.ts';
import { dataDir, loadConfig } from '../../config/config.ts';
import type { Config } from '../../config/config.ts';
import { anthropicProvider } from '../../generate/anthropic.ts';
import { generateArticle, generateNote, InvalidOutputError, slugify } from '../../generate/generate.ts';
import { openaiCompatProvider } from '../../generate/openai-compat.ts';
import type { Provider } from '../../generate/provider.ts';
import { UsageError, ProviderError } from '../../util/errors.ts';
import { atomicWriteFile } from '../../util/fs.ts';
import type { Ctx } from '../context.ts';
import { emit, flag, makeClient, str } from '../shared.ts';
import type { Command } from '../shared.ts';
import { storeFor } from './note.ts';

async function buildProvider(ctx: Ctx, config: Config, override: string | undefined): Promise<Provider> {
  const kind = override ?? config.generate.provider;
  const { model, timeoutMs, baseUrl } = config.generate;
  if (kind === 'anthropic') {
    const apiKey = await getApiKey(ctx.env, 'anthropic');
    if (!apiKey) throw new ProviderError('ANTHROPIC_API_KEY non configurata (variabile d\'ambiente o secrets.json)');
    return anthropicProvider({ apiKey, model, timeoutMs, baseUrl, fetchImpl: ctx.fetchImpl });
  }
  if (kind === 'openai-compat') {
    if (!baseUrl) throw new UsageError('generate.baseUrl mancante in config.json (es. http://localhost:8080 per llama.cpp)');
    return openaiCompatProvider({ baseUrl, model, timeoutMs, apiKey: await getApiKey(ctx.env, 'llm'), fetchImpl: ctx.fetchImpl });
  }
  throw new UsageError(`Provider sconosciuto: ${kind} (anthropic | openai-compat)`);
}

function topicOf(values: Record<string, unknown>): string {
  const topic = values.topic;
  if (typeof topic !== 'string' || topic.trim() === '') throw new UsageError('Serve --topic "<argomento>"');
  return topic.trim();
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export const generateCommands: Command[] = [
  {
    path: 'generate article',
    summary: 'Genera un articolo con un LLM e lo salva in drafts/ (con --draft crea anche la bozza online)',
    options: { topic: { type: 'string' }, lang: { type: 'string' }, provider: { type: 'string' }, draft: { type: 'boolean' } },
    async run(ctx, { values }) {
      const config = await loadConfig(ctx.env);
      const provider = await buildProvider(ctx, config, str(values, 'provider'));
      const opts = { topic: topicOf(values), lang: str(values, 'lang') ?? 'it', maxTokens: config.generate.maxTokens };
      const folder = join(dataDir(ctx.env), 'drafts');
      let result;
      try {
        result = await generateArticle(provider, opts);
      } catch (e) {
        if (e instanceof InvalidOutputError) {
          const rejected = join(folder, `rifiutato-${stamp(ctx.now())}.md`);
          await atomicWriteFile(rejected, e.raw);
          throw new ProviderError(`${e.message}\nTesto grezzo salvato in ${rejected}`);
        }
        throw e;
      }
      const file = join(folder, `${slugify(result.article.frontMatter.title)}-${stamp(ctx.now())}.md`);
      await atomicWriteFile(file, result.markdown + '\n');
      const out: Record<string, unknown> = { file, title: result.article.frontMatter.title };
      let human = `Articolo generato: ${file}`;
      if (flag(values, 'draft')) {
        const client = await makeClient(ctx);
        const profile = await client.getProfile();
        const draft = await client.createDraft({
          title: result.article.frontMatter.title, subtitle: result.article.frontMatter.subtitle,
          body: result.article.doc, authorId: profile.id,
        });
        out.draftId = draft.id;
        out.url = draft.url;
        human += `\nBozza creata: id ${draft.id}\nModifica: ${draft.url}`;
      }
      emit(ctx, values, out, human);
      return 0;
    },
  },
  {
    path: 'generate note',
    summary: 'Genera una nota con un LLM e la aggiunge alla coda locale (draft)',
    options: { topic: { type: 'string' }, lang: { type: 'string' }, provider: { type: 'string' } },
    async run(ctx, { values }) {
      const config = await loadConfig(ctx.env);
      const provider = await buildProvider(ctx, config, str(values, 'provider'));
      const text = await generateNote(provider, { topic: topicOf(values), lang: str(values, 'lang') ?? 'it', maxTokens: config.generate.maxTokens });
      const note = await storeFor(ctx).add(text, ctx.now());
      emit(ctx, values, note, `Nota generata (draft): ${note.id}\n${text}`);
      return 0;
    },
  },
];
```

`src/cli/commands/config.ts`:

```ts
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
```

Nota: se con `--force` si sovrascrive un config precedente e la validazione fallisce, il file viene rimosso (accettabile: l'utente ha chiesto `--force`).

- [ ] **Step 7: Esegui test del router, typecheck, smoke manuale, commit**

Run: `node --test tests/unit/cli/router.test.ts && npm run typecheck`
Expected: PASS.

Run: `node src/cli/main.ts help && node src/cli/main.ts auth guide | head -5`
Expected: elenco comandi; prime righe della guida.

```bash
git add -A && git commit -m "feat(cli): contesto, router e comandi auth/article/note/generate/config" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Test funzionali (CLI reale contro server finti)

**Files:**
- Create: `tests/helpers/fake-server.ts`, `tests/helpers/fake-substack.ts`, `tests/helpers/cli.ts`, `tests/functional/article.test.ts`, `tests/functional/notes.test.ts`, `tests/functional/generate.test.ts`, `tests/functional/auth.test.ts`

- [ ] **Step 1: Helper**

`tests/helpers/fake-server.ts`:

```ts
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded { method: string; path: string; headers: IncomingHttpHeaders; body: string }
export type Handler = (req: Recorded, res: ServerResponse, raw: IncomingMessage) => void;

export class FakeServer {
  readonly requests: Recorded[] = [];
  handler: Handler;
  private server: Server;
  url = '';

  private constructor(handler: Handler) {
    this.handler = handler;
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const rec: Recorded = {
          method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8'),
        };
        this.requests.push(rec);
        this.handler(rec, res, req);
      });
    });
  }

  static async start(handler: Handler): Promise<FakeServer> {
    const s = new FakeServer(handler);
    await new Promise<void>((resolve) => s.server.listen(0, '127.0.0.1', resolve));
    s.url = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}`;
    return s;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  count(method: string, pathPrefix: string): number {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix)).length;
  }
}

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
```

`tests/helpers/fake-substack.ts`:

```ts
import { FakeServer, sendJson } from './fake-server.ts';
import type { Handler } from './fake-server.ts';

export const VALID_SID = 's%3AfunctionalTestCookie1234567890.sig';

export const defaultSubstack: Handler = (req, res) => {
  if (!String(req.headers.cookie ?? '').includes(`substack.sid=${VALID_SID}`)) return sendJson(res, { error: 'unauthorized' }, 401);
  const { method, path } = req;
  if (method === 'GET' && path === '/api/v1/user/profile/self') return sendJson(res, { id: 42, name: 'Ada Test', handle: 'ada' });
  if (method === 'POST' && path === '/api/v1/drafts') return sendJson(res, { id: 1001 });
  if (method === 'GET' && path === '/api/v1/drafts/1001') return sendJson(res, { id: 1001, draft_title: 'Titolo di prova' });
  if (method === 'GET' && path.startsWith('/api/v1/post_management/drafts')) return sendJson(res, { posts: [{ id: 1001, draft_title: 'Titolo di prova' }] });
  if (method === 'POST' && /^\/api\/v1\/drafts\/\d+\/(publish|scheduled_release)$/.test(path)) return sendJson(res, {});
  if (method === 'POST' && path === '/api/v1/comment/feed') return sendJson(res, { id: 'note-777' });
  return sendJson(res, { error: 'not found' }, 404);
};

export const startFakeSubstack = (handler = defaultSubstack): Promise<FakeServer> => FakeServer.start(handler);
```

`tests/helpers/cli.ts`:

```ts
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VALID_SID } from './fake-substack.ts';

export interface CliResult { code: number | null; stdout: string; stderr: string }

export interface Sandbox {
  configDir: string;
  dataDir: string;
  env: Record<string, string>;
  run(args: string[], opts?: { stdin?: string; env?: Record<string, string> }): Promise<CliResult>;
  cleanup(): Promise<void>;
}

const ENTRY = resolve(process.env.CLI_ENTRY ?? 'src/cli/main.ts');

export async function makeSandbox(baseUrl: string, extraEnv: Record<string, string> = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'substack-func-'));
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    SUBSTACK_CLI_CONFIG_DIR: configDir,
    SUBSTACK_CLI_DATA_DIR: dataDir,
    SUBSTACK_BASE_URL: baseUrl,
    SUBSTACK_SID: VALID_SID,
    SUBSTACK_PUBLICATION: 'testpub',
    SUBSTACK_ALLOW_TEST_CLOCK: '1',
    ...extraEnv,
  };
  return {
    configDir, dataDir, env,
    run: (args, opts = {}) => new Promise((done, fail) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, ...args], {
        env: { ...env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', fail);
      child.on('close', (code) => done({ code, stdout, stderr }));
      child.stdin.end(opts.stdin ?? '');
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
```

- [ ] **Step 2: Test funzionali di auth e articoli**

`tests/functional/auth.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { startFakeSubstack, VALID_SID } from '../helpers/fake-substack.ts';

test('auth set da stdin salva il cookie (0600) e lo verifica; auth check ok', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url, { SUBSTACK_SID: '' });
  try {
    delete (sb.env as Record<string, string | undefined>).SUBSTACK_SID;
    const set = await sb.run(['auth', 'set'], { stdin: `substack.sid=${VALID_SID};\n` });
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /Sessione valida: Ada Test/);
    const saved = JSON.parse(await readFile(join(sb.configDir, 'secrets.json'), 'utf8'));
    assert.equal(saved.sid, VALID_SID);
    const check = await sb.run(['auth', 'check', '--json']);
    assert.equal(check.code, 0);
    assert.deepEqual(JSON.parse(check.stdout), { valid: true, id: 42, name: 'Ada Test', handle: 'ada' });
  } finally { await sb.cleanup(); await server.stop(); }
});

test('cookie scaduto/errato → exit 2 e il cookie non compare mai nell\'output', async () => {
  const server = await startFakeSubstack();
  const bad = 's%3AcookieSbagliato1234567890.xxx';
  const sb = await makeSandbox(server.url, { SUBSTACK_SID: bad });
  try {
    const r = await sb.run(['auth', 'check']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /auth guide/);
    assert.ok(!r.stdout.includes(bad) && !r.stderr.includes(bad));
  } finally { await sb.cleanup(); await server.stop(); }
});

test('cookie non configurato → exit 2; cookie malformato → exit 64', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    delete (sb.env as Record<string, string | undefined>).SUBSTACK_SID;
    assert.equal((await sb.run(['auth', 'check'])).code, 2);
    assert.equal((await sb.run(['auth', 'set'], { stdin: 'valore; con spazi' })).code, 64);
  } finally { await sb.cleanup(); await server.stop(); }
});
```

`tests/functional/article.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { startFakeSubstack, VALID_SID } from '../helpers/fake-substack.ts';

const ARTICLE = '---\ntitle: Titolo di prova\nsubtitle: Sottotitolo\n---\n\n## Intro\n\nTesto **forte** con [link](https://example.com).\n\n- uno\n- due\n';

async function setup() {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  const file = join(sb.configDir, '..', 'articolo.md');
  await writeFile(file, ARTICLE);
  return { server, sb, file, done: async () => { await sb.cleanup(); await server.stop(); } };
}

test('article draft da file crea la bozza con corpo ProseMirror e cookie corretto', async () => {
  const { server, sb, file, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', file]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Bozza creata: id 1001/);
    const post = server.requests.find((q) => q.method === 'POST' && q.path === '/api/v1/drafts')!;
    assert.match(String(post.headers.cookie), new RegExp(`substack.sid=${VALID_SID.replace(/\./g, '\\.')}`));
    const body = JSON.parse(post.body);
    assert.equal(body.draft_title, 'Titolo di prova');
    assert.equal(body.draft_subtitle, 'Sottotitolo');
    const doc = JSON.parse(body.draft_body);
    assert.equal(doc.type, 'doc');
    assert.deepEqual(doc.content.map((n: { type: string }) => n.type), ['heading', 'paragraph', 'bullet_list']);
    assert.deepEqual(body.draft_bylines, [{ id: 42, is_guest: false }]);
  } finally { await done(); }
});

test('article draft da stdin e --json', async () => {
  const { sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', '-', '--json'], { stdin: ARTICLE });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).id, 1001);
  } finally { await done(); }
});

test('article draft --dry-run non fa nessuna richiesta', async () => {
  const { server, sb, file, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', file, '--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /dry-run/);
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});

test('Markdown non valido → exit 64 e nessuna richiesta', async () => {
  const { server, sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'draft', '-'], { stdin: '---\ntitle: T\n---\n\n[x](javascript:alert(1))' });
    assert.equal(r.code, 64);
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});

test('article list', async () => {
  const { sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'list']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /1001\tTitolo di prova/);
  } finally { await done(); }
});

test('article publish non interattivo: senza --yes fallisce SENZA toccare Substack', async () => {
  const { server, sb, done } = await setup();
  try {
    const r = await sb.run(['article', 'publish', '1001']);
    assert.equal(r.code, 64);
    assert.match(r.stderr, /--yes/);
    assert.equal(server.requests.length, 0);
  } finally { await done(); }
});

test('article publish --yes: senza email di default, con --send-email invia', async () => {
  const { server, sb, done } = await setup();
  try {
    assert.equal((await sb.run(['article', 'publish', '1001', '--yes'])).code, 0);
    assert.equal(JSON.parse(server.requests.find((q) => q.path.endsWith('/publish'))!.body).send, false);
    assert.equal((await sb.run(['article', 'publish', '1001', '--yes', '--send-email'])).code, 0);
    const sends = server.requests.filter((q) => q.path.endsWith('/publish')).map((q) => JSON.parse(q.body).send);
    assert.deepEqual(sends, [false, true]);
  } finally { await done(); }
});

test('article publish --dry-run e id non valido', async () => {
  const { server, sb, done } = await setup();
  try {
    const dry = await sb.run(['article', 'publish', '1001', '--dry-run']);
    assert.equal(dry.code, 0);
    assert.equal(server.count('POST', '/api/v1/drafts/1001/publish'), 0);
    assert.equal((await sb.run(['article', 'publish', '../1', '--yes'])).code, 64);
  } finally { await done(); }
});

test('article schedule / cancel', async () => {
  const { server, sb, done } = await setup();
  try {
    const env = { SUBSTACK_NOW: '2026-10-08T10:00:00Z' };
    const ok = await sb.run(['article', 'schedule', '1001', '--at', '2026-10-09T09:00:00+02:00'], { env });
    assert.equal(ok.code, 0, ok.stderr);
    const sch = JSON.parse(server.requests.find((q) => q.path.endsWith('/scheduled_release'))!.body);
    assert.equal(sch.trigger_at, '2026-10-09T07:00:00.000Z');
    assert.equal(sch.email_audience, 'no_one');
    assert.equal((await sb.run(['article', 'schedule', '1001', '--at', '2026-10-07T09:00:00Z'], { env })).code, 64);
    assert.equal((await sb.run(['article', 'schedule', '1001', '--at', '2026-10-09T09:00:00'], { env })).code, 64);
    assert.equal((await sb.run(['article', 'schedule', '1001'], { env })).code, 64);
    assert.equal((await sb.run(['article', 'schedule', '1001', '--cancel'], { env })).code, 0);
    const last = JSON.parse(server.requests.filter((q) => q.path.endsWith('/scheduled_release')).at(-1)!.body);
    assert.equal(last.trigger_at, null);
  } finally { await done(); }
});
```

- [ ] **Step 3: Test funzionali delle note e della generazione**

`tests/functional/notes.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox } from '../helpers/cli.ts';
import { defaultSubstack, startFakeSubstack } from '../helpers/fake-substack.ts';
import { sendJson } from '../helpers/fake-server.ts';

const T0 = { SUBSTACK_NOW: '2026-10-08T10:00:00Z' };
const T1 = { SUBSTACK_NOW: '2026-10-08T12:00:01Z' };

async function addScheduled(sb: Awaited<ReturnType<typeof makeSandbox>>, text: string) {
  const add = await sb.run(['note', 'add', text, '--json'], { env: T0 });
  assert.equal(add.code, 0, add.stderr);
  const id = JSON.parse(add.stdout).id as string;
  const sch = await sb.run(['note', 'schedule', id, '--at', '2026-10-08T12:00:00Z'], { env: T0 });
  assert.equal(sch.code, 0, sch.stderr);
  return id;
}

test('note: add → list → schedule → run-due pubblica solo a scadenza, una volta sola', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    const id = await addScheduled(sb, 'Ciao **mondo**');
    const list = await sb.run(['note', 'list', '--status', 'scheduled'], { env: T0 });
    assert.match(list.stdout, new RegExp(id));

    const early = await sb.run(['notes', 'run-due'], { env: T0 });
    assert.equal(early.code, 0);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 0);

    const due = await sb.run(['notes', 'run-due'], { env: T1 });
    assert.equal(due.code, 0, due.stderr);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 1);
    const posted = JSON.parse(server.requests.find((q) => q.path === '/api/v1/comment/feed')!.body);
    assert.equal(posted.bodyJson.type, 'doc');

    const again = await sb.run(['notes', 'run-due'], { env: T1 });
    assert.equal(again.code, 0);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 1);
    assert.match((await sb.run(['note', 'list', '--status', 'published'])).stdout, new RegExp(id));
  } finally { await sb.cleanup(); await server.stop(); }
});

test('crash/timeout durante la pubblicazione: nota in publishing, nessun doppio post, exit 6, poi resolve', async () => {
  const server = await startFakeSubstack((req, res, raw) => {
    if (req.path === '/api/v1/comment/feed') { raw.socket.destroy(); return; }
    defaultSubstack(req, res, raw);
  });
  const sb = await makeSandbox(server.url);
  try {
    const id = await addScheduled(sb, 'incerta');
    const first = await sb.run(['notes', 'run-due'], { env: T1 });
    assert.equal(first.code, 6, first.stderr);
    assert.match(first.stdout, /INCERTA/);
    const posts = server.count('POST', '/api/v1/comment/feed');
    assert.equal(posts, 1);

    const second = await sb.run(['notes', 'run-due'], { env: T1 });
    assert.equal(second.code, 6);
    assert.match(second.stdout, /BLOCCATA/);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), posts); // nessun secondo tentativo

    assert.equal((await sb.run(['note', 'resolve', id, '--published'])).code, 0);
    assert.equal((await sb.run(['notes', 'run-due'], { env: T1 })).code, 0);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('cookie scaduto durante run-due: exit 2 e la nota resta schedulata', async () => {
  const server = await startFakeSubstack((_req, res) => sendJson(res, {}, 401));
  const sb = await makeSandbox(server.url);
  try {
    const id = await addScheduled(sb, 'x');
    const r = await sb.run(['notes', 'run-due'], { env: T1 });
    assert.equal(r.code, 2);
    assert.match((await sb.run(['note', 'list', '--status', 'scheduled'])).stdout, new RegExp(id));
  } finally { await sb.cleanup(); await server.stop(); }
});

test('note publish immediata, unschedule, id non valido, note add da stdin e validazione', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    const add = await sb.run(['note', 'add', '-', '--json'], { stdin: 'da stdin\n', env: T0 });
    const id = JSON.parse(add.stdout).id as string;
    const pub = await sb.run(['note', 'publish', id], { env: T0 });
    assert.equal(pub.code, 0, pub.stderr);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 1);
    assert.equal((await sb.run(['note', 'publish', id])).code, 6); // già pubblicata

    const id2 = await addScheduled(sb, 'altra');
    assert.equal((await sb.run(['note', 'unschedule', id2])).code, 0);
    assert.equal((await sb.run(['notes', 'run-due'], { env: T1 })).code, 0);
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 1);

    assert.equal((await sb.run(['note', 'publish', '../etc/passwd'])).code, 64);
    assert.equal((await sb.run(['note', 'add', '<script>x</script>'])).code, 64);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('notes run-due --dry-run non contatta Substack', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    await addScheduled(sb, 'x');
    const r = await sb.run(['notes', 'run-due', '--dry-run', '--json'], { env: T1 });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).due.length, 1);
    assert.equal(server.requests.length, 0);
  } finally { await sb.cleanup(); await server.stop(); }
});
```

`tests/functional/generate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { startFakeSubstack } from '../helpers/fake-substack.ts';
import { FakeServer, sendJson } from '../helpers/fake-server.ts';

const llm = (text: string) => FakeServer.start((_req, res) => sendJson(res, { choices: [{ message: { content: text } }] }));

async function configure(sb: Awaited<ReturnType<typeof makeSandbox>>, llmUrl: string) {
  await mkdir(sb.configDir, { recursive: true });
  await writeFile(join(sb.configDir, 'config.json'), JSON.stringify({
    generate: { provider: 'openai-compat', model: 'locale', baseUrl: llmUrl },
  }));
}

test('generate article (openai-compat): salva il file; con --draft crea la bozza', async () => {
  const sub = await startFakeSubstack();
  const model = await llm('```markdown\n---\ntitle: Generato\n---\n\nCorpo **ok**.\n```');
  const sb = await makeSandbox(sub.url);
  try {
    await configure(sb, model.url);
    const r = await sb.run(['generate', 'article', '--topic', 'Rust', '--draft', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.draftId, 1001);
    assert.match(await readFile(out.file, 'utf8'), /^---\ntitle: Generato/);
    assert.equal(JSON.parse(model.requests[0]!.body).messages[1].content.includes('Rust'), true);
  } finally { await sb.cleanup(); await sub.stop(); await model.stop(); }
});

test('generate article senza --draft non contatta Substack', async () => {
  const sub = await startFakeSubstack();
  const model = await llm('---\ntitle: Solo file\n---\n\nTesto.');
  const sb = await makeSandbox(sub.url);
  try {
    await configure(sb, model.url);
    assert.equal((await sb.run(['generate', 'article', '--topic', 'x'])).code, 0);
    assert.equal(sub.requests.length, 0);
  } finally { await sb.cleanup(); await sub.stop(); await model.stop(); }
});

test('output non valido dell\'LLM: exit 5, testo grezzo salvato come rifiutato, nessuna bozza', async () => {
  const sub = await startFakeSubstack();
  const model = await llm('Nessun front-matter, solo testo <b>html</b>');
  const sb = await makeSandbox(sub.url);
  try {
    await configure(sb, model.url);
    const r = await sb.run(['generate', 'article', '--topic', 'x', '--draft']);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /rifiutato-/);
    const files = await readdir(join(sb.dataDir, 'drafts'));
    assert.equal(files.length, 1);
    assert.equal(sub.count('POST', '/api/v1/drafts'), 0);
  } finally { await sb.cleanup(); await sub.stop(); await model.stop(); }
});

test('generate note aggiunge una nota draft alla coda', async () => {
  const sub = await startFakeSubstack();
  const model = await llm('Una nota **breve**.');
  const sb = await makeSandbox(sub.url);
  try {
    await configure(sb, model.url);
    const r = await sb.run(['generate', 'note', '--topic', 'x']);
    assert.equal(r.code, 0, r.stderr);
    assert.match((await sb.run(['note', 'list', '--status', 'draft'])).stdout, /Una nota/);
  } finally { await sb.cleanup(); await sub.stop(); await model.stop(); }
});

test('LLM non raggiungibile → exit 5; senza --topic → exit 64; anthropic senza chiave → exit 5', async () => {
  const sub = await startFakeSubstack();
  const sb = await makeSandbox(sub.url);
  try {
    await configure(sb, 'http://127.0.0.1:1');
    assert.equal((await sb.run(['generate', 'article', '--topic', 'x'])).code, 5);
    assert.equal((await sb.run(['generate', 'article'])).code, 64);
    assert.equal((await sb.run(['generate', 'article', '--topic', 'x', '--provider', 'anthropic'])).code, 5);
  } finally { await sb.cleanup(); await sub.stop(); }
});
```

- [ ] **Step 4: Esegui i test funzionali**

Run: `npm run test:functional`
Expected: PASS. Eventuali fallimenti si correggono nel codice di `src/` (non indebolendo i test): in particolare verificare i codici di uscita attesi (2, 5, 6, 64).

- [ ] **Step 5: Esegui l'intera suite, il build e i funzionali sul codice compilato**

Run: `npm run typecheck && npm test && npm run build`
Run: `CLI_ENTRY=dist/cli/main.js npm run test:functional`
Expected: tutto PASS (la seconda esecuzione prova il binario compilato che andrà in Docker).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "test: suite funzionale del CLI contro server Substack e LLM finti" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Mutation testing

**Files:**
- Create: `stryker.config.json`
- Possibly modify: test unitari (nuovi test per uccidere i mutanti sopravvissuti)

- [ ] **Step 1: Configura Stryker (runner a comando, solo test unitari)**

`stryker.config.json`:

```json
{
  "$schema": "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  "testRunner": "command",
  "commandRunner": { "command": "node --test \"tests/unit/**/*.test.ts\"" },
  "mutate": [
    "src/util/**/*.ts",
    "src/config/**/*.ts",
    "src/markdown/**/*.ts",
    "src/notes/**/*.ts",
    "src/substack/**/*.ts",
    "src/auth/store.ts",
    "src/generate/**/*.ts"
  ],
  "coverageAnalysis": "off",
  "concurrency": 4,
  "timeoutMS": 60000,
  "tempDirName": ".stryker-tmp",
  "ignorePatterns": ["dist", "docs", "deploy", "reports", ".stryker-tmp"],
  "reporters": ["clear-text", "html", "json"],
  "htmlReporter": { "fileName": "reports/mutation/index.html" },
  "jsonReporter": { "fileName": "reports/mutation/mutation.json" },
  "thresholds": { "high": 90, "low": 80, "break": 80 }
}
```

- [ ] **Step 2: Esegui la mutazione**

Run: `npm run mutation`
Expected: report a console con mutation score per file e totale. Se Stryker non riesce a parsare i `.ts` con import `.ts` o a eseguire il comando nel sandbox, controlla che `node --test` funzioni nella cartella `.stryker-tmp/sandbox-*` e adatta `ignorePatterns`/`tempDirName`; non cambiare l'approccio (niente `tsc` nel ciclo).

- [ ] **Step 3: Analizza i mutanti sopravvissuti**

Per ogni file sotto l'80%: apri il report HTML (`reports/mutation/index.html`) e, per ciascun mutante sopravvissuto, decidi:
- **test mancante** → aggiungi un test unitario che fallisce con quel mutante (asserzione sul valore esatto, sui confini `<`/`<=`, sui messaggi d'errore, sull'ordine);
- **mutante equivalente** (il comportamento osservabile non cambia, es. testo di un messaggio solo informativo) → annotalo in `reports/mutation/EQUIVALENTS.md` con file:riga e motivo, oppure escludilo con un commento `// Stryker disable next-line <mutatore>: <motivo>`.

Ripeti `npm run mutation` finché il totale è ≥ 80% e nessun modulo critico (`markdown/`, `notes/`, `util/clock.ts`, `util/fs.ts`, `substack/client.ts`) è sotto l'80%.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: mutation testing con Stryker (soglia 80%) e test aggiuntivi sui sopravvissuti" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Deploy (Docker, k3s, systemd) e README

**Files:**
- Create: `deploy/Dockerfile`, `deploy/.dockerignore` (alla radice: `.dockerignore`), `deploy/k3s/{namespace,secret.example,configmap,pvc,cronjob,job-auth-check,toolbox}.yaml`, `deploy/systemd/substack-notes.service`, `deploy/systemd/substack-notes.timer`, `README.md`

- [ ] **Step 1: Dockerfile e .dockerignore**

`deploy/Dockerfile`:

```dockerfile
# Build dalla radice del repository:  docker build -f deploy/Dockerfile -t substack-cli:0.1.0 .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    SUBSTACK_CLI_CONFIG_DIR=/config \
    SUBSTACK_CLI_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /config /data && chown -R node:node /config /data
USER node
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["help"]
```

`.dockerignore` (radice):

```
node_modules
dist
.git
.stryker-tmp
reports
docs
tests
```

- [ ] **Step 2: Manifest k3s**

`deploy/k3s/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: substack
```

`deploy/k3s/secret.example.yaml` (NON committare valori reali; rinnovo cookie nel README):

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: substack-secrets
  namespace: substack
type: Opaque
stringData:
  SUBSTACK_SID: "SOSTITUISCI-CON-IL-VALORE-DEL-COOKIE"
  # ANTHROPIC_API_KEY: "sk-ant-..."        # solo se usi il provider anthropic
  # SUBSTACK_LLM_API_KEY: "..."            # solo se il server LLM richiede una chiave
```

`deploy/k3s/configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: substack-config
  namespace: substack
data:
  config.json: |
    {
      "publication": "SOSTITUISCI-SUBDOMAIN",
      "generate": {
        "provider": "openai-compat",
        "model": "locale",
        "baseUrl": "http://llama-cpp.llm.svc.cluster.local:8080"
      }
    }
```

`deploy/k3s/pvc.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: substack-data
  namespace: substack
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: local-path
  resources:
    requests:
      storage: 1Gi
```

`deploy/k3s/cronjob.yaml`:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: substack-notes-run-due
  namespace: substack
spec:
  schedule: "* * * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      backoffLimit: 0
      activeDeadlineSeconds: 300
      template:
        spec:
          restartPolicy: Never
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            runAsGroup: 1000
            fsGroup: 1000
          containers:
            - name: run-due
              image: substack-cli:0.1.0
              imagePullPolicy: IfNotPresent
              args: ["notes", "run-due"]
              envFrom:
                - secretRef:
                    name: substack-secrets
              securityContext:
                allowPrivilegeEscalation: false
                readOnlyRootFilesystem: true
                capabilities:
                  drop: ["ALL"]
              volumeMounts:
                - { name: config, mountPath: /config, readOnly: true }
                - { name: data, mountPath: /data }
          volumes:
            - name: config
              configMap:
                name: substack-config
            - name: data
              persistentVolumeClaim:
                claimName: substack-data
```

`deploy/k3s/job-auth-check.yaml`:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: substack-auth-check
  namespace: substack
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 }
      containers:
        - name: auth-check
          image: substack-cli:0.1.0
          imagePullPolicy: IfNotPresent
          args: ["auth", "check"]
          envFrom:
            - secretRef: { name: substack-secrets }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: config, mountPath: /config, readOnly: true }
      volumes:
        - name: config
          configMap: { name: substack-config }
```

`deploy/k3s/toolbox.yaml` (opzionale, per `kubectl exec`):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: substack-toolbox
  namespace: substack
spec:
  replicas: 1
  selector:
    matchLabels: { app: substack-toolbox }
  template:
    metadata:
      labels: { app: substack-toolbox }
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 }
      containers:
        - name: toolbox
          image: substack-cli:0.1.0
          imagePullPolicy: IfNotPresent
          command: ["sleep", "infinity"]
          envFrom:
            - secretRef: { name: substack-secrets }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: config, mountPath: /config, readOnly: true }
            - { name: data, mountPath: /data }
      volumes:
        - name: config
          configMap: { name: substack-config }
        - name: data
          persistentVolumeClaim: { claimName: substack-data }
# Uso:  kubectl -n substack exec -it deploy/substack-toolbox -- node /app/dist/cli/main.js article list
# Nota: la PVC è ReadWriteOnce (local-path): CronJob e toolbox funzionano perché k3s a nodo singolo li schedula sullo stesso nodo.
```

- [ ] **Step 3: systemd**

`deploy/systemd/substack-notes.service`:

```ini
[Unit]
Description=Substack CLI - pubblica le note schedulate scadute
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=substack
Environment=SUBSTACK_CLI_CONFIG_DIR=/etc/substack-cli
Environment=SUBSTACK_CLI_DATA_DIR=/var/lib/substack-cli
EnvironmentFile=-/etc/substack-cli/env
ExecStart=/usr/bin/node /opt/substack-cli/dist/cli/main.js notes run-due
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/substack-cli
PrivateTmp=true
```

`deploy/systemd/substack-notes.timer`:

```ini
[Unit]
Description=Esegue substack notes run-due ogni minuto

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: README**

Scrivi `README.md` con queste sezioni (contenuto concreto, niente segnaposto):
1. **Cos'è e avvertenze**: API interne non documentate; uso a rischio dell'utente; gli articoli non vengono mai pubblicati senza `--yes`; email solo con `--send-email`.
2. **Requisiti e installazione**: Node ≥ 22.18; `npm ci && npm run build && npm i -g .` (comando `substack`).
3. **Configurazione**: `substack config init --publication <subdomain> [--provider openai-compat --llm-base-url http://localhost:8080 --model ...]`; variabili d'ambiente (`SUBSTACK_SID`, `ANTHROPIC_API_KEY`, `SUBSTACK_LLM_API_KEY`, `SUBSTACK_CLI_CONFIG_DIR`, `SUBSTACK_CLI_DATA_DIR`).
4. **Autenticazione (tutorial passo passo)**: riprendi il testo di `src/auth/guide.ts` (stessi 6 passi, variante SSH, variante Playwright, variante k3s).
5. **Uso**: esempi per ogni comando (bozza da Markdown con front-matter `title`/`subtitle`; `article publish 123 --yes [--send-email]`; `article schedule 123 --at 2026-10-09T09:00:00+02:00`; `note add`, `note schedule`, `notes run-due`; `generate article --topic ... --draft`; uso con llama.cpp: `llama-server -m modello.gguf --port 8080` + `config init --provider openai-compat --llm-base-url http://localhost:8080`).
6. **Exit code**: tabella 0/1/2/3/4/5/6/64.
7. **Deploy**: Docker (`docker build -f deploy/Dockerfile -t substack-cli:0.1.0 .`, import in k3s con `docker save substack-cli:0.1.0 | sudo k3s ctr images import -`), applicare i manifest (`kubectl apply -f deploy/k3s/namespace.yaml` … ), creazione del Secret senza committarlo, rinnovo del cookie, lettura dei fallimenti del CronJob (`kubectl -n substack get jobs`), systemd (installazione dei due file in `/etc/systemd/system`, `systemctl enable --now substack-notes.timer`).
8. **Sviluppo**: `npm test`, `npm run typecheck`, `npm run mutation`, struttura delle cartelle.
9. **Risoluzione problemi**: exit 2 (cookie), exit 3 (API cambiata → aprire una issue con endpoint/campo), exit 6 (nota in `publishing`: `note list --status publishing`, controllare su Substack, `note resolve`).

- [ ] **Step 5: Verifica del build Docker (se Docker è disponibile)**

Run: `docker build -f deploy/Dockerfile -t substack-cli:0.1.0 . && docker run --rm substack-cli:0.1.0 help`
Expected: stampa l'elenco dei comandi. Se Docker non è installato, annotalo nel report finale come "non verificato" (non dichiarare il Dockerfile testato).

Run: `docker run --rm substack-cli:0.1.0 auth guide | head -3` e `docker run --rm substack-cli:0.1.0 ls /app` non servono: basta verificare che l'immagine parta e che `node_modules` contenga solo i 3 pacchetti (`docker run --rm --entrypoint sh substack-cli:0.1.0 -c "ls /app/node_modules"` → `marked yaml zod`).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(deploy): Dockerfile, manifest k3s, systemd e README" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Red team

**Files:**
- Create: `tests/security/secrets.test.ts`, `tests/security/input.test.ts`, `tests/security/gating.test.ts`, `tests/security/fuzz.test.ts`, `docs/superpowers/reports/2026-10-08-red-team.md`

Obiettivo: cercare **attivamente** di rompere il codice. Ogni problema trovato → test di regressione che fallisce → correzione → test verde. Nessun problema va "accettato" senza una riga motivata nel report.

- [ ] **Step 1: Test di sicurezza concreti (partenza)**

`tests/security/secrets.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeSandbox } from '../helpers/cli.ts';
import { defaultSubstack, startFakeSubstack, VALID_SID } from '../helpers/fake-substack.ts';
import { sendJson } from '../helpers/fake-server.ts';

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

test('il cookie non compare in stdout/stderr/--json/file di dati, nemmeno quando il server lo riflette negli errori', async () => {
  const server = await startFakeSubstack((req, res, raw) => {
    if (req.path === '/api/v1/user/profile/self') return sendJson(res, { error: `cookie ${VALID_SID} rifiutato`, cookie: req.headers.cookie }, 500);
    defaultSubstack(req, res, raw);
  });
  const sb = await makeSandbox(server.url);
  try {
    const runs = [
      await sb.run(['auth', 'check']),
      await sb.run(['auth', 'check', '--json']),
      await sb.run(['article', 'list']),
      await sb.run(['config', 'show']),
      await sb.run(['note', 'add', 'x', '--json']),
    ];
    for (const r of runs) {
      assert.ok(!r.stdout.includes(VALID_SID) && !r.stderr.includes(VALID_SID), r.stderr);
    }
    for (const f of await allFiles(sb.dataDir)) assert.ok(!(await readFile(f, 'utf8')).includes(VALID_SID), f);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('SUBSTACK_DEBUG=1 non stampa il cookie nemmeno negli stack trace', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    const r = await sb.run(['article', 'publish', 'abc', '--yes'], { env: { SUBSTACK_DEBUG: '1' } });
    assert.ok(!r.stderr.includes(VALID_SID));
  } finally { await sb.cleanup(); await server.stop(); }
});
```

`tests/security/input.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToDoc } from '../../src/markdown/prosemirror.ts';
import { NoteStore } from '../../src/notes/store.ts';
import { loadConfig } from '../../src/config/config.ts';
import { normalizeSid } from '../../src/auth/store.ts';
import { SubstackClient } from '../../src/substack/client.ts';
import { json, makeFetch } from '../helpers/fetch.ts';
import { withTmpDir } from '../helpers/tmp.ts';

const BAD_LINKS = [
  '[x](javascript:alert(1))', '[x](  javascript:alert(1))', '[x](JAVASCRIPT:alert(1))', '[x](java\tscript:alert(1))',
  '[x](data:text/html,<script>alert(1)</script>)', '[x](vbscript:msgbox(1))', '[x](file:///etc/passwd)',
  '[x](//evil.example/a)', '[x](\\\\evil\\share)', '[x][ref]\n\n[ref]: javascript:alert(1)',
  '<a href="javascript:alert(1)">x</a>', '![x](javascript:alert(1))', '![x](http://169.254.169.254/latest/meta-data)',
];

test('nessun link/immagine pericoloso supera il convertitore', () => {
  for (const md of BAD_LINKS) {
    let doc: unknown;
    try { doc = markdownToDoc(md); } catch { continue; }
    const text = JSON.stringify(doc);
    assert.ok(!/javascript:|data:text|vbscript:|file:|169\.254|evil\.example/i.test(text), `${md} → ${text}`);
  }
});

test('un id di nota non può uscire dalla cartella delle note', async () => {
  await withTmpDir(async (dir) => {
    const store = new NoteStore(dir);
    for (const id of ['../../etc/passwd', '..%2f..%2fx', 'a/../../b', '\u0000', 'C:\\x']) {
      await assert.rejects(store.get(id));
    }
  });
});

test('SUBSTACK_BASE_URL ostile viene rifiutato (il cookie non parte verso host arbitrari)', async () => {
  await withTmpDir(async (dir) => {
    for (const url of ['http://evil.example', 'http://127.0.0.1.evil.example', 'http://localhost.evil.example', 'https://u:p@evil.example@localhost']) {
      const env = { SUBSTACK_CLI_CONFIG_DIR: dir, SUBSTACK_BASE_URL: url };
      if (url.startsWith('https://')) continue; // https è ammesso per scelta: l'operatore decide dove punta
      await assert.rejects(loadConfig(env), `${url}`);
    }
  });
});

test('cookie con CRLF o separatori non può iniettare header', () => {
  for (const bad of ['abc\r\nX-Evil: 1xxxxxxxxxx', 'abcdefghijklmnop; admin=1', 'abcdefghijklmnop\nxx']) {
    assert.throws(() => normalizeSid(bad));
  }
});

test('risposta con redirect verso altro host non viene seguita', async () => {
  const calls: string[] = [];
  const c = new SubstackClient({
    sid: 's%3AabcdefGHIJKLmnop1234567890.sig', publicationUrl: 'https://p.example', globalUrl: 'https://g.example',
    fetchImpl: makeFetch((call) => {
      calls.push(call.url);
      return new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } });
    }),
    sleep: async () => {},
  });
  await assert.rejects(c.getProfile());
  assert.ok(calls.every((u) => !u.includes('evil.example')));
});

test('risposta JSON ostile (prototype pollution, enorme) non rompe il client', async () => {
  const c = new SubstackClient({
    sid: 's%3AabcdefGHIJKLmnop1234567890.sig', publicationUrl: 'https://p.example', globalUrl: 'https://g.example',
    fetchImpl: makeFetch(() => new Response('{"id":1,"__proto__":{"polluted":true},"constructor":{"x":1}}', { status: 200 })),
  });
  await c.getProfile();
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  const c2 = new SubstackClient({
    sid: 's%3AabcdefGHIJKLmnop1234567890.sig', publicationUrl: 'https://p.example', globalUrl: 'https://g.example',
    fetchImpl: makeFetch(() => json({ id: 1, huge: 'x'.repeat(1_000_000) })),
  });
  await c2.getProfile();
});
```

`tests/security/gating.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox } from '../helpers/cli.ts';
import { startFakeSubstack } from '../helpers/fake-substack.ts';

test('nessuna combinazione non interattiva pubblica senza --yes', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    for (const args of [
      ['article', 'publish', '1001'],
      ['article', 'publish', '1001', '--send-email'],
      ['article', 'publish', '1001', '--json'],
      ['article', 'publish', '1001', '--yes=false'],
      ['article', 'publish', '1001', '-y'],
    ]) {
      const r = await sb.run(args, { stdin: 'pubblica\n' }); // anche con "pubblica" su stdin
      assert.notEqual(r.code, 0, args.join(' '));
    }
    assert.equal(server.count('POST', '/api/v1/drafts/1001/publish'), 0);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('generate e note non pubblicano né schedulano articoli', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url);
  try {
    await sb.run(['generate', 'article', '--topic', 'x', '--draft']);
    assert.equal(server.count('POST', '/api/v1/drafts/') + server.requests.filter((q) => /publish|scheduled_release/.test(q.path)).length, 0);
  } finally { await sb.cleanup(); await server.stop(); }
});

test('SUBSTACK_NOW senza SUBSTACK_ALLOW_TEST_CLOCK=1 è ignorato (nessuna pubblicazione anticipata)', async () => {
  const server = await startFakeSubstack();
  const sb = await makeSandbox(server.url, { SUBSTACK_ALLOW_TEST_CLOCK: '' });
  try {
    const add = await sb.run(['note', 'add', 'x', '--json']);
    const id = JSON.parse(add.stdout).id as string;
    await sb.run(['note', 'schedule', id, '--at', '2999-01-01T00:00:00Z']);
    await sb.run(['notes', 'run-due'], { env: { SUBSTACK_NOW: '3000-01-01T00:00:00Z' } });
    assert.equal(server.count('POST', '/api/v1/comment/feed'), 0);
  } finally { await sb.cleanup(); await server.stop(); }
});
```

`tests/security/fuzz.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToDoc } from '../../src/markdown/prosemirror.ts';
import { parseArticle } from '../../src/markdown/frontmatter.ts';
import { CliError } from '../../src/util/errors.ts';

// PRNG deterministico (mulberry32) per risultati riproducibili
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ['# ', '## ', '- ', '1. ', '> ', '```', '`', '**', '*', '_', '[a](', ')', '![i](', 'https://x.io', 'javascript:', '<b>', '</b>', '|', '---', '\n', '\n\n', '  ', '\t', '&amp;', '&', '<', '\\', 'ciao', 'è', '日本', '\u202e', '\u0000', '[', ']', '(', '- [ ] ', '    '];

function* corpus(n: number) {
  const r = rng(12345);
  for (let i = 0; i < n; i++) {
    const len = 1 + Math.floor(r() * 40);
    let s = '';
    for (let j = 0; j < len; j++) s += PIECES[Math.floor(r() * PIECES.length)];
    yield s;
  }
}

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) return node.forEach((c) => walk(c, visit));
  if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((c) => walk(c, visit));
  }
}

test('fuzz Markdown: o errore tipizzato, o documento sicuro; mai crash né schemi vietati', () => {
  let ok = 0;
  for (const input of corpus(3000)) {
    try {
      const doc = markdownToDoc(input);
      ok++;
      walk(doc, (n) => {
        const href = (n.attrs as { href?: string; src?: string } | undefined);
        for (const u of [href?.href, href?.src]) {
          if (u !== undefined) assert.match(u, /^(https?:|mailto:)/i, `schema vietato da: ${JSON.stringify(input)}`);
        }
        if (n.type === 'text') assert.ok(typeof n.text === 'string' && (n.text as string).length > 0);
      });
    } catch (e) {
      assert.ok(e instanceof CliError, `eccezione non tipizzata da ${JSON.stringify(input)}: ${e}`);
    }
  }
  assert.ok(ok > 100, 'il corpus deve produrre anche input validi');
});

test('fuzz front-matter: mai eccezioni non tipizzate', () => {
  for (const input of corpus(1500)) {
    for (const wrapped of [`---\ntitle: T\n---\n\n${input}`, `---\n${input}\n---\n\nx`, input]) {
      try { parseArticle(wrapped); } catch (e) { assert.ok(e instanceof CliError, `${JSON.stringify(wrapped)} → ${e}`); }
    }
  }
});

test('input patologici terminano in tempo ragionevole', () => {
  const t0 = Date.now();
  for (const s of ['*'.repeat(50_000), '['.repeat(20_000), '> '.repeat(5_000) + 'x', '`'.repeat(30_000), '_a'.repeat(30_000), '![a]('.repeat(5_000)]) {
    try { markdownToDoc(s); } catch (e) { assert.ok(e instanceof CliError); }
  }
  assert.ok(Date.now() - t0 < 10_000, `troppo lento: ${Date.now() - t0}ms`);
});
```

- [ ] **Step 2: Esegui e correggi**

Run: `node --test "tests/security/**/*.test.ts"`
Expected: parte dei test può fallire: sono i primi bug trovati. Per ognuno: capisci la causa, correggi `src/` (non il test, salvo che l'asserzione fosse sbagliata e lo si motivi nel report), riesegui. Casi attesi da guardare con attenzione: eccezioni non `CliError` dal lexer `marked` o da ricorsione profonda (`RangeError`) → incapsula in `markdownToDoc` con `try/catch` che converte in `UsageError`; input patologici lenti (ReDoS) → ridurre il limite di input o troncare prima del lexer; `--yes=false` o `-y` che passano il parsing in modo inatteso.

- [ ] **Step 3: Revisione avversaria indipendente**

Invoca la skill `adversarial-thinking` e `security-review` sul codice di `src/`, poi lancia un subagente (`feature-dev:code-reviewer` o `general-purpose`) con questo brief, **senza** anticipargli le conclusioni:

> Sei un red team. Repository: `F:\GitHub\substack` (CLI TypeScript che usa un cookie di sessione Substack e può pubblicare contenuti). Leggi `docs/superpowers/specs/2026-10-08-substack-cli-design.md` §12 e tutto `src/`. Cerca di: (1) far uscire il cookie/le chiavi da qualsiasi canale; (2) far pubblicare/schedulare contenuti senza conferma esplicita; (3) far scrivere/leggere file fuori dalle cartelle di dati/config; (4) mandare il cookie a un host diverso da quello previsto; (5) provocare doppie pubblicazioni di note o perdita di stato; (6) mandare in crash o in loop il CLI con input, file di coda o risposte HTTP ostili. Per ogni problema: file:riga, scenario d'attacco concreto, gravità, test che lo dimostra. Non correggere nulla; segnala solo problemi verificati leggendo il codice, e distingui i sospetti non verificati.

Per ogni problema segnalato che sia riproducibile: scrivi prima il test di regressione (deve fallire), poi correggi.

- [ ] **Step 4: Verifica della gestione dei segreti nel container**

Run (se Docker disponibile): `docker run --rm --entrypoint sh substack-cli:0.1.0 -c "id && ls -la /config /data && env | grep -i -E 'sid|key' || echo 'nessun segreto nell immagine'"`
Expected: utente `node` (non root), nessun segreto nell'immagine.
Controlla anche `docker history substack-cli:0.1.0` per assicurarti che nessun layer contenga file di test, `.git` o `docs`.

- [ ] **Step 5: Report del red team**

Crea `docs/superpowers/reports/2026-10-08-red-team.md` con: metodo, elenco dei problemi trovati (id, gravità, file:riga, scenario, correzione, test di regressione), elenco dei rischi accettati con motivazione (es. `SUBSTACK_BASE_URL` https verso host scelto dall'operatore; API interne instabili), e cosa NON è stato verificato (es. comportamento reale di Substack se la Fase 0 non ha confermato le scritture).

- [ ] **Step 6: Rilancia tutto e committa**

Run: `npm run typecheck && npm test && npm run build && CLI_ENTRY=dist/cli/main.js npm run test:functional && npm run mutation`
Expected: tutto verde; mutation score ≥ 80%.

```bash
git add -A && git commit -m "test(security): red team, correzioni e test di regressione" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Verifica finale

- [ ] **Step 1: Skill `superpowers:verification-before-completion`**: esegui e leggi l'output reale (non assumere) di: `npm run typecheck`, `npm test`, `npm run build`, `CLI_ENTRY=dist/cli/main.js npm run test:functional`, `npm run mutation`, `npm ls --omit=dev --all`.
- [ ] **Step 2: Checklist rispetto allo spec** (§1–§14): ogni comando di §4 esiste ed è coperto da un test funzionale; salvaguardie di pubblicazione (§4) coperte da `tests/security/gating.test.ts`; errori/exit code (§7) coperti; deploy (§10) presente; Fase 0 (§11) documentata in `tests/fixtures/README.md` con lo stato di conferma di ogni endpoint.
- [ ] **Step 3: Report all'utente**: cosa è verificato (con i comandi eseguiti e i risultati), cosa NON lo è (endpoint di scrittura non confermati se l'utente non ha autorizzato la Fase 0; Docker non provato se non disponibile; nessun test contro Substack reale), mutation score per modulo, problemi del red team e stato.
