import { UsageError } from './errors.ts';

/** Orologio finto per i test (SUBSTACK_NOW), valido solo con SUBSTACK_ALLOW_TEST_CLOCK=1 esatto. */
export function testClockNow(env: NodeJS.ProcessEnv): Date | undefined {
  if (env.SUBSTACK_ALLOW_TEST_CLOCK === '1' && env.SUBSTACK_NOW) {
    const d = new Date(env.SUBSTACK_NOW);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

export function currentTime(env: NodeJS.ProcessEnv): Date {
  return testClockNow(env) ?? new Date();
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
