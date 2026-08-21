import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseScreenshotManifest, validateScreenshotBundle } from '../src/screenshots.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture')]);
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
