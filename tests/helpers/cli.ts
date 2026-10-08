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
