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
