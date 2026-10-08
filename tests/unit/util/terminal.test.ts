import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeForTerminal } from '../../../src/util/text.ts';

const ch = (cp: number) => String.fromCodePoint(cp);
const BACKSLASH = String.fromCharCode(92);
const esc = (cp: number) => `${BACKSLASH}u${cp.toString(16).padStart(4, '0')}`;

test('escapeForTerminal: ogni intervallo pericoloso, estremi inclusi, diventa uXXXX con backslash', () => {
  const unsafe = [0x00, 0x08, 0x0b, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x9b, 0x9f, 0x61c, 0x200b, 0x200f, 0x2028, 0x2029,
    0x202a, 0x202e, 0x2066, 0x2069, 0xfeff];
  for (const cp of unsafe) assert.equal(escapeForTerminal(`a${ch(cp)}b`), `a${esc(cp)}b`, cp.toString(16));
  // tutte le occorrenze, non solo la prima
  assert.equal(escapeForTerminal(`${ch(0x1b)}]0;x${ch(7)}${ch(0x1b)}[2J`), `${esc(0x1b)}]0;x${esc(7)}${esc(0x1b)}[2J`);
});

test('escapeForTerminal: tab, a capo, testo normale e vicini degli intervalli restano invariati', () => {
  const safe = [0x09, 0x0a, 0x20, 0x7e, 0xa0, 0xe8, 0x61b, 0x61d, 0x200a, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a, 0xfefe, 0xff00];
  for (const cp of safe) assert.equal(escapeForTerminal(`a${ch(cp)}b`), `a${ch(cp)}b`, cp.toString(16));
  const plain = `Ciao ${ch(0x65e5)}${ch(0x672c)} ${ch(0x1f600)}\n\tok`;
  assert.equal(escapeForTerminal(plain), plain);
});

test('escapeForTerminal su JSON: resta JSON valido con lo stesso valore', () => {
  const value = { t: `x${ch(0x9b)}31m${ch(0x202e)}${BACKSLASH}${ch(0x85)}y${ch(0x1b)}` };
  const out = escapeForTerminal(JSON.stringify(value));
  assert.ok(!/[\u0080-\u009f\u202e]/.test(out));
  assert.deepEqual(JSON.parse(out), value);
});
