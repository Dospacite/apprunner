import fs from 'node:fs';
import path from 'node:path';

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function parseScreenshotManifest(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  if (payload?.version !== 1 || !Array.isArray(payload.screenshots) || !payload.screenshots.length) {
    throw new Error('manifest.json must contain a non-empty version 1 screenshot list');
  }
  if (payload.screenshots.length > 100) throw new Error('a screenshot journey may contain at most 100 images');

  const names = new Set();
  return payload.screenshots.map((item, ordinal) => {
    if (!item || !NAME.test(item.name)) throw new Error(`invalid screenshot name at ordinal ${ordinal}`);
    if (names.has(item.name)) throw new Error(`duplicate screenshot name: ${item.name}`);
    names.add(item.name);
    if (item.ordinal !== ordinal) throw new Error(`screenshot ${item.name} has a non-contiguous ordinal`);
    if (item.filename !== `${item.name}.png`) throw new Error(`screenshot ${item.name} has an invalid filename`);
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 8) {
      throw new Error(`screenshot ${item.name} has an invalid byte count`);
    }
    if (!SHA256.test(item.sha256)) throw new Error(`screenshot ${item.name} has an invalid SHA-256`);
    return { ...item };
  });
}

async function walkFiles(directory) {
  const files = [];
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export async function validateScreenshotBundle(directory, sha256Of) {
  const files = await walkFiles(directory);
  const manifests = files.filter((file) => path.basename(file) === 'manifest.json');
  if (manifests.length !== 1) throw new Error('the screenshot artifact must contain exactly one manifest.json');

  const manifestPath = manifests[0];
  const root = path.dirname(manifestPath);
  const screenshots = parseScreenshotManifest(await fs.promises.readFile(manifestPath, 'utf8'));
  const expected = new Set(screenshots.map((item) => path.join(root, item.filename)));
  const actualPngs = files.filter((file) => path.extname(file).toLowerCase() === '.png');
  if (actualPngs.length !== expected.size || actualPngs.some((file) => !expected.has(file))) {
    throw new Error('the PNG files do not exactly match manifest.json');
  }

  for (const item of screenshots) {
    const sourcePath = path.join(root, item.filename);
    const handle = await fs.promises.open(sourcePath, 'r');
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    try {
      await handle.read(signature, 0, signature.length, 0);
    } finally {
      await handle.close();
    }
    if (!signature.equals(PNG_SIGNATURE)) throw new Error(`${item.filename} is not a PNG`);
    const sizeBytes = (await fs.promises.stat(sourcePath)).size;
    if (sizeBytes !== item.sizeBytes) throw new Error(`${item.filename} byte count does not match manifest.json`);
    const sha256 = await sha256Of(sourcePath);
    if (sha256 !== item.sha256) throw new Error(`${item.filename} SHA-256 does not match manifest.json`);
    item.sourcePath = sourcePath;
  }
  return screenshots;
}
