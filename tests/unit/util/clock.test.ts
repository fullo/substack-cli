import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentTime, parseFutureInstant, parseInstant } from '../../../src/util/clock.ts';
import { UsageError } from '../../../src/util/errors.ts';

test('currentTime ignora SUBSTACK_NOW senza il consenso esplicito di test', () => {
  const t = currentTime({ SUBSTACK_NOW: '2020-01-01T00:00:00Z' });
  assert.notEqual(t.getUTCFullYear(), 2020);
});

test('currentTime usa SUBSTACK_NOW solo con SUBSTACK_ALLOW_TEST_CLOCK=1', () => {
  const t = currentTime({ SUBSTACK_NOW: '2020-01-01T00:00:00Z', SUBSTACK_ALLOW_TEST_CLOCK: '1' });
  assert.equal(t.toISOString(), '2020-01-01T00:00:00.000Z');
});

test('currentTime ignora un SUBSTACK_NOW non valido', () => {
  const t = currentTime({ SUBSTACK_NOW: 'boh', SUBSTACK_ALLOW_TEST_CLOCK: '1' });
  assert.ok(!Number.isNaN(t.getTime()));
  assert.ok(t.getUTCFullYear() >= 2026);
});

test('parseInstant accetta Z e offset', () => {
  assert.equal(parseInstant('2026-10-09T09:00:00+02:00').toISOString(), '2026-10-09T07:00:00.000Z');
  assert.equal(parseInstant('2026-10-09T09:00Z').toISOString(), '2026-10-09T09:00:00.000Z');
  assert.equal(parseInstant('2026-10-09T09:00:30.5-05:00').toISOString(), '2026-10-09T14:00:30.500Z');
});

test('parseInstant rifiuta date senza offset, impossibili o malformate', () => {
  for (const bad of ['2026-10-09T09:00:00', '2026-10-09', '2026-02-30T10:00:00Z',
    '2026-13-01T10:00:00Z', '2026-10-09T24:00:00Z', '2026-10-09T10:60:00Z', 'domani', '']) {
    assert.throws(() => parseInstant(bad), UsageError, bad);
  }
});

test('parseInstant accetta il 29 febbraio solo negli anni bisestili', () => {
  assert.equal(parseInstant('2028-02-29T10:00:00Z').toISOString(), '2028-02-29T10:00:00.000Z');
  assert.throws(() => parseInstant('2027-02-29T10:00:00Z'), UsageError);
});

test('parseFutureInstant richiede una data strettamente futura', () => {
  const now = new Date('2026-10-08T10:00:00Z');
  assert.throws(() => parseFutureInstant('2026-10-08T10:00:00Z', now), UsageError);
  assert.throws(() => parseFutureInstant('2026-10-08T09:59:59Z', now), UsageError);
  assert.equal(parseFutureInstant('2026-10-08T10:00:01Z', now).toISOString(), '2026-10-08T10:00:01.000Z');
});
