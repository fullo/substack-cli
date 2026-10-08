import { test } from 'node:test';
import assert from 'node:assert/strict';

test('il runner esegue TypeScript direttamente', () => {
  const x: number = 1 + 1;
  assert.equal(x, 2);
});
