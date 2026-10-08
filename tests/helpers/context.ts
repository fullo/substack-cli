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
    stdinIsTTY: false,
    prompt: async () => '',
    now: () => new Date('2026-10-08T10:00:00Z'),
    fetchImpl: (async () => { throw new Error('rete non consentita nei test'); }) as typeof fetch,
    ...overrides,
    stdout,
    stderr,
  };
}
