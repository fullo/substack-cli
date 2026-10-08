#!/usr/bin/env node
import { createContext } from './context.ts';
import { run } from './router.ts';
import { installLockCleanupOnSignals } from '../util/fs.ts';

installLockCleanupOnSignals();

process.exitCode = await run(process.argv.slice(2), createContext());
