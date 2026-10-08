import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ZodIssue } from 'zod';
import { formatIssues } from '../../../src/util/issues.ts';

const unknownKeys = (keys: string[], path: (string | number)[] = []): ZodIssue =>
  ({ code: 'unrecognized_keys', keys, path, message: 'x' }) as ZodIssue;
const other = (n: number): ZodIssue => ({ code: 'custom', path: [`c${n}`], message: `m${n}` }) as ZodIssue;

test('formatIssues: chiavi sconosciute fino a 5 elencate tutte, oltre troncate', () => {
  assert.equal(formatIssues([unknownKeys(['a', 'b', 'c', 'd', 'e'])]), '(radice): chiavi non ammesse: a, b, c, d, e');
  assert.equal(formatIssues([unknownKeys(['a', 'b', 'c', 'd', 'e', 'f'], ['generate'])]),
    'generate: chiavi non ammesse: a, b, c, d, e (e altre 1)');
});

test('formatIssues: nomi di chiave oltre 40 caratteri accorciati', () => {
  const k40 = 'k'.repeat(40);
  assert.equal(formatIssues([unknownKeys([k40, `${k40}x`])]), `(radice): chiavi non ammesse: ${k40}, ${k40}…`);
});

test('formatIssues: al massimo 10 problemi, poi il conteggio', () => {
  const ten = Array.from({ length: 10 }, (_, i) => other(i));
  assert.equal(formatIssues(ten), ten.map((_, i) => `c${i}: m${i}`).join('; '));
  const twelve = Array.from({ length: 12 }, (_, i) => other(i));
  assert.equal(formatIssues(twelve), `${ten.map((_, i) => `c${i}: m${i}`).join('; ')}; (e altri 2 problemi)`);
});
