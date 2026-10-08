import { createInterface } from 'node:readline/promises';
import { currentTime } from '../util/clock.ts';
import { UsageError } from '../util/errors.ts';
import { redact } from '../util/redact.ts';
import { escapeForTerminal } from '../util/text.ts';

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
    out: (text) => { process.stdout.write(escapeForTerminal(redact(text)) + '\n'); },
    err: (text) => { process.stderr.write(escapeForTerminal(redact(text)) + '\n'); },
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
