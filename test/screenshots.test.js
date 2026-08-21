import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseScreenshotManifest, validateScreenshotBundle } from '../src/screenshots.js';

const png = (width, height, suffix = '') => {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.from(`fixture${suffix}`)]);
};
const PNG = png(750, 1334);
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sha256Of = async (file) => digest(await fs.promises.readFile(file));

test('parseScreenshotManifest preserves named capture order', () => {
  const items = parseScreenshotManifest(JSON.stringify({
    version: 1,
    screenshots: [
      { name: 'question', ordinal: 0, filename: 'question.png', sizeBytes: PNG.length, sha256: digest(PNG) },
      { name: 'reveal', ordinal: 1, filename: 'reveal.png', sizeBytes: PNG.length, sha256: digest(PNG) },
    ],
  }));
  assert.deepEqual(items.map(({ name, ordinal }) => ({ name, ordinal })), [
    { name: 'question', ordinal: 0 },
    { name: 'reveal', ordinal: 1 },
  ]);
});

test('validateScreenshotBundle rejects files outside the manifest set', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'screenshots-test-'));
  try {
    await fs.promises.writeFile(path.join(directory, 'question.png'), PNG);
    await fs.promises.writeFile(path.join(directory, 'extra.png'), PNG);
    await fs.promises.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      version: 1,
      screenshots: [
        { name: 'question', ordinal: 0, filename: 'question.png', sizeBytes: PNG.length, sha256: digest(PNG) },
      ],
    }));
    await assert.rejects(validateScreenshotBundle(directory, sha256Of), /do not exactly match/);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('validateScreenshotBundle returns verified source files', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'screenshots-test-'));
  try {
    await fs.promises.writeFile(path.join(directory, 'question.png'), PNG);
    await fs.promises.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      version: 1,
      screenshots: [
        { name: 'question', ordinal: 0, filename: 'question.png', sizeBytes: PNG.length, sha256: digest(PNG) },
      ],
    }));
    const [item] = await validateScreenshotBundle(directory, sha256Of);
    assert.equal(item.sourcePath, path.join(directory, 'question.png'));
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('validates a multi-phone manifest with actual PNG dimensions', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'screenshots-test-'));
  try {
    const compact = path.join(directory, 'phones', 'compact');
    const large = path.join(directory, 'phones', 'large');
    await fs.promises.mkdir(compact, { recursive: true });
    await fs.promises.mkdir(large, { recursive: true });
    const compactPng = png(750, 1334);
    const largePng = png(1320, 2868);
    await fs.promises.writeFile(path.join(compact, 'question.png'), compactPng);
    await fs.promises.writeFile(path.join(large, 'question.png'), largePng);
    await fs.promises.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
      version: 2,
      phones: [
        {
          key: 'compact', ordinal: 0,
          requested: { kind: 'preset', preset: 'compact' },
          resolved: { model: 'iPhone SE (3rd generation)', runtime: 'iOS 18.5' },
          screenshots: [{ name: 'question', ordinal: 0, filename: 'phones/compact/question.png', widthPixels: 750, heightPixels: 1334, sizeBytes: compactPng.length, sha256: digest(compactPng) }],
        },
        {
          key: 'large', ordinal: 1,
          requested: { kind: 'preset', preset: 'large' },
          resolved: { model: 'iPhone 16 Pro Max', runtime: 'iOS 18.5' },
          screenshots: [{ name: 'question', ordinal: 0, filename: 'phones/large/question.png', widthPixels: 1320, heightPixels: 2868, sizeBytes: largePng.length, sha256: digest(largePng) }],
        },
      ],
    }));

    const items = await validateScreenshotBundle(directory, sha256Of);
    assert.deepEqual(items.map(({ phoneKey, widthPixels, heightPixels }) => ({ phoneKey, widthPixels, heightPixels })), [
      { phoneKey: 'compact', widthPixels: 750, heightPixels: 1334 },
      { phoneKey: 'large', widthPixels: 1320, heightPixels: 2868 },
    ]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
