// Test aggiuntivi dall'analisi dei mutanti (Stryker): confini esatti di parseInstant, messaggi d'errore,
// condizioni di attivazione dell'orologio di test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentTime, parseFutureInstant, parseInstant } from '../../../src/util/clock.ts';
import { UsageError } from '../../../src/util/errors.ts';

const iso = (s: string) => parseInstant(s).toISOString();

test('currentTime: serve SUBSTACK_ALLOW_TEST_CLOCK esattamente "1" e un SUBSTACK_NOW', () => {
  const before = Date.now();
  for (const allow of ['0', 'true', '', ' 1']) {
    const t = currentTime({ SUBSTACK_NOW: '2020-01-01T00:00:00Z', SUBSTACK_ALLOW_TEST_CLOCK: allow });
    assert.ok(t.getTime() >= before, allow);
  }
  const t = currentTime({ SUBSTACK_ALLOW_TEST_CLOCK: '1' });
  assert.ok(t.getTime() >= before && t.getTime() <= Date.now());
  const empty = currentTime({ SUBSTACK_ALLOW_TEST_CLOCK: '1', SUBSTACK_NOW: '' });
  assert.ok(empty.getTime() >= before);
});

test('parseInstant: messaggio d\'errore esatto con l\'input originale', () => {
  assert.throws(() => parseInstant(' boh '), (e: unknown) => e instanceof UsageError &&
    e.message === 'Data non valida: " boh ". Usa ISO 8601 con offset, es. 2026-10-09T09:00:00+02:00 oppure 2026-10-09T07:00:00Z');
  for (const bad of ['2026-02-30T10:00:00Z', '2026-10-09T25:00Z']) {
    assert.throws(() => parseInstant(bad), (e: unknown) => e instanceof UsageError && e.message.startsWith(`Data non valida: "${bad}"`));
  }
});

test('parseInstant: spazi esterni ignorati', () => {
  assert.equal(iso('  2026-10-09T09:00:00Z \n'), '2026-10-09T09:00:00.000Z');
});

test('parseInstant: confini di mese, giorno, ora, minuti, secondi', () => {
  assert.equal(iso('2026-01-01T00:00:00Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(iso('2026-12-31T23:59:59Z'), '2026-12-31T23:59:59.000Z');
  assert.equal(iso('2026-04-30T10:00Z'), '2026-04-30T10:00:00.000Z');
  for (const bad of ['2026-00-10T10:00Z', '2026-12-32T10:00Z', '2026-04-31T10:00Z', '2026-10-00T10:00Z',
    '2026-10-09T23:60Z', '2026-10-09T23:59:60Z', '2026-10-09T24:00Z', '2026-13-01T00:00Z']) {
    assert.throws(() => parseInstant(bad), UsageError, bad);
  }
});

test('parseInstant: frazioni di secondo da 1 a 3 cifre, non di più', () => {
  assert.equal(iso('2026-10-09T09:00:00.1Z'), '2026-10-09T09:00:00.100Z');
  assert.equal(iso('2026-10-09T09:00:00.12Z'), '2026-10-09T09:00:00.120Z');
  assert.equal(iso('2026-10-09T09:00:00.123Z'), '2026-10-09T09:00:00.123Z');
  for (const bad of ['2026-10-09T09:00:00.1234Z', '2026-10-09T09:00:00.Z', '2026-10-09T09:00.5Z']) {
    assert.throws(() => parseInstant(bad), UsageError, bad);
  }
});

test('parseInstant: formato rigido (cifre, separatori, offset)', () => {
  assert.equal(iso('2026-10-09T09:00-00:30'), '2026-10-09T09:30:00.000Z');
  assert.equal(iso('2026-10-09T09:00+14:00'), '2026-10-08T19:00:00.000Z');
  for (const bad of ['x2026-10-09T09:00Z', '2026-10-09T09:00Zx', '20261-10-09T09:00Z',
    '2026-1-09T09:00Z', '2026-10-9T09:00Z', '2026-10-09T9:00Z', '2026-10-09T09:0Z', '2026-10-09T09:00:0Z',
    '2026-10-09 09:00Z', '2026-10-09T09:00+0200', '2026-10-09T09:00+02', '2026-10-09T09:00z', '2026-10-09T09:00*02:00',
    'aaaa-bb-ccTdd:eeZ', '2026-10-09T09:00:00+2:00']) {
    assert.throws(() => parseInstant(bad), UsageError, bad);
  }
});

test('parseInstant: offset fuori intervallo (accettato dalla regex, rifiutato da Date) → UsageError, mai Invalid Date', () => {
  for (const bad of ['2026-10-09T09:00+24:00', '2026-10-09T09:00-23:60', '2026-10-09T09:00:00+99:99']) {
    assert.throws(() => parseInstant(bad), (e: unknown) => e instanceof UsageError && e.message.startsWith(`Data non valida: "${bad}"`), bad);
  }
});

test('parseFutureInstant: messaggio esatto e confine al millisecondo', () => {
  const now = new Date('2026-10-08T10:00:00.000Z');
  assert.throws(() => parseFutureInstant('2026-10-08T10:00:00Z', now), (e: unknown) =>
    e instanceof UsageError && e.message === 'La data 2026-10-08T10:00:00.000Z non è nel futuro');
  assert.equal(parseFutureInstant('2026-10-08T10:00:00.001Z', now).toISOString(), '2026-10-08T10:00:00.001Z');
  assert.throws(() => parseFutureInstant('domani', now), /Data non valida/);
});
