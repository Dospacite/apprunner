import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeScreenshotPhones } from '../src/screenshot-phones.js';

test('omitted screenshot phones preserve the single default phone', () => {
  assert.deepEqual(normalizeScreenshotPhones(), ['default']);
});

test('normalizes presets and structured exact phones without losing order', () => {
  assert.deepEqual(normalizeScreenshotPhones([
    'compact',
    { key: 'support-case', model: ' iPhone 15 Pro ', runtime: '18.4' },
  ]), [
    'compact',
    { key: 'support-case', model: 'iPhone 15 Pro', runtime: '18.4' },
  ]);
});

test('rejects duplicate phone keys', () => {
  assert.throws(
    () => normalizeScreenshotPhones(['compact', { key: 'compact', model: 'iPhone 15' }]),
    /duplicate screenshot phone key/,
  );
});
