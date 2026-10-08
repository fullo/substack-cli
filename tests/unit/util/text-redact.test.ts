// Test aggiuntivi dall'analisi dei mutanti (Stryker): confini esatti dei caratteri vietati, redazione
// (soglia di 8 caratteri, varianti codificate, pattern), codici degli errori.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FORBIDDEN_TEXT_CHARS, hasForbiddenChars, isSafeSingleLine } from '../../../src/util/text.ts';
import { clearSecrets, redact, registerSecret } from '../../../src/util/redact.ts';
import {
  ApiShapeError, AuthError, NetworkError, ProviderError, RateLimitError, StateError, UsageError,
} from '../../../src/util/errors.ts';

beforeEach(() => clearSecrets());

const ch = (cp: number) => String.fromCodePoint(cp);

test('caratteri vietati: ogni intervallo, estremi inclusi; i vicini ammessi', () => {
  const forbidden = [0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f, 0x061c, 0x200b, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e,
    0x2066, 0x2069, 0xfeff, 0x200c, 0x202c, 0x2067, 0x05];
  const allowed = [0x09, 0x0a, 0x0d, 0x20, 0x7e, 0x80 + 0x20, 0x061b, 0x061d, 0x200a, 0x2010, 0x2027, 0x202f, 0x2065,
    0x206a, 0xfefe, 0xff00, 0x41, 0xe8];
  for (const cp of forbidden) assert.equal(hasForbiddenChars(`a${ch(cp)}b`), true, cp.toString(16));
  for (const cp of allowed) assert.equal(hasForbiddenChars(`a${ch(cp)}b`), false, cp.toString(16));
  assert.equal(FORBIDDEN_TEXT_CHARS.global, false); // test() senza stato tra chiamate
  assert.equal(hasForbiddenChars('\u0000'), true);
  assert.equal(hasForbiddenChars('\u0000'), true);
});

test('isSafeSingleLine: vietati tab, CR, LF e i caratteri vietati; ammesso il resto', () => {
  assert.equal(isSafeSingleLine('Titolo è "ok" — sì'), true);
  assert.equal(isSafeSingleLine(''), true);
  for (const bad of ['a\tb', 'a\rb', 'a\nb', 'a​b', '\t', '\n']) assert.equal(isSafeSingleLine(bad), false, JSON.stringify(bad));
});

test('registerSecret: soglia di 8 caratteri inclusa', () => {
  registerSecret('1234567');
  assert.equal(redact('x 1234567 y'), 'x 1234567 y');
  registerSecret('12345678');
  assert.equal(redact('x 12345678 y 12345678'), 'x [REDACTED] y [REDACTED]');
  registerSecret('');
  assert.equal(redact(''), '');
});

test('registerSecret: undefined e valori corti non registrano nemmeno le varianti (decodificata/codificata)', () => {
  registerSecret(undefined); // decodeURIComponent(undefined) sarebbe "undefined" (9 caratteri)
  assert.equal(redact('undefined'), 'undefined');
  registerSecret('a b c d'); // 7 caratteri; codificato "a%20b%20c%20d" ne avrebbe 13
  assert.equal(redact('a%20b%20c%20d'), 'a%20b%20c%20d');
});

test('registerSecret: valore non decodificabile registrato comunque, più la variante codificata', () => {
  registerSecret('abc%E0%A4%Azz');
  assert.equal(redact('[abc%E0%A4%Azz]'), '[[REDACTED]]');
  assert.equal(redact(encodeURIComponent('abc%E0%A4%Azz')), '[REDACTED]');
  clearSecrets();
  assert.equal(redact('abc%E0%A4%Azz'), 'abc%E0%A4%Azz');
});

test('redact: varianti corte (< 8) generate dalla decodifica non vengono usate', () => {
  registerSecret('%41%42%43%44'); // decodificato "ABCD": troppo corto per essere mascherato
  assert.equal(redact('ABCD e %41%42%43%44'), 'ABCD e [REDACTED]');
});

test('redact per pattern: substack.sid case-insensitive fino a ; spazio o virgolette; sk-ant con almeno 8 caratteri', () => {
  assert.equal(redact('SUBSTACK.SID=abc"x'), 'substack.sid=[REDACTED]"x');
  assert.equal(redact("substack.sid=abc'x substack.sid=def ghi"), "substack.sid=[REDACTED]'x substack.sid=[REDACTED] ghi");
  assert.equal(redact('substack.sid=;'), 'substack.sid=;');
  assert.equal(redact('sk-ant-1234567'), 'sk-ant-1234567');
  assert.equal(redact('sk-ant-12345678'), '[REDACTED]');
  assert.equal(redact('xsk-ant-12345678'), 'xsk-ant-12345678');
  assert.equal(redact('sk-ant-abc_DEF-1234!'), '[REDACTED]!');
});

test('errori: codice simbolico di ciascuna classe', () => {
  assert.deepEqual(
    [new UsageError('x'), new AuthError('x'), new ApiShapeError('x'), new NetworkError('x'), new RateLimitError('x'),
      new ProviderError('x'), new StateError('x')].map((e) => e.code),
    ['USAGE', 'AUTH', 'API_SHAPE', 'NETWORK', 'RATE_LIMIT', 'PROVIDER', 'STATE'],
  );
});
