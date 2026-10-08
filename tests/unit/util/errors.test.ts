import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiShapeError, AuthError, CliError, NetworkError, ProviderError,
  RateLimitError, StateError, UsageError,
} from '../../../src/util/errors.ts';

test('ogni errore ha il suo exit code e nome', () => {
  const cases: [CliError, number, string][] = [
    [new UsageError('x'), 64, 'UsageError'],
    [new AuthError('x'), 2, 'AuthError'],
    [new ApiShapeError('x'), 3, 'ApiShapeError'],
    [new NetworkError('x'), 4, 'NetworkError'],
    [new RateLimitError('x'), 4, 'RateLimitError'],
    [new ProviderError('x'), 5, 'ProviderError'],
    [new StateError('x'), 6, 'StateError'],
  ];
  for (const [err, code, name] of cases) {
    assert.ok(err instanceof CliError);
    assert.ok(err instanceof Error);
    assert.equal(err.exitCode, code);
    assert.equal(err.name, name);
    assert.equal(err.message, 'x');
  }
});

test('ApiShapeError conserva lo status HTTP, RateLimitError il retry-after', () => {
  assert.equal(new ApiShapeError('x', 404).httpStatus, 404);
  assert.equal(new ApiShapeError('x').httpStatus, undefined);
  assert.equal(new RateLimitError('x', 1500).retryAfterMs, 1500);
  assert.equal(new RateLimitError('x').retryAfterMs, undefined);
});
