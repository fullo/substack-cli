#!/usr/bin/env node
import { createContext } from './context.ts';
import { run } from './router.ts';

process.exitCode = await run(process.argv.slice(2), createContext());
