import fs from 'node:fs';
import path from 'node:path';

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function parseScreenshotManifest(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  if (payload?.version === 1) {
    if (!Array.isArray(payload.screenshots) || !payload.screenshots.length) {
      throw new Error('manifest.json must contain a non-empty version 1 screenshot list');
    }
    return parseImages(payload.screenshots, {
      phoneKey: 'default', phoneOrdinal: 0, requested: { kind: 'preset', preset: 'default' },
      resolved: null, prefix: '', requireDimensions: false,
    });
  }
  if (payload?.version !== 2 || !Array.isArray(payload.phones) || !payload.phones.length) {
    throw new Error('manifest.json must contain a non-empty version 1 or version 2 screenshot set');
  }
  if (payload.phones.length > 4) throw new Error('a screenshot set may contain at most four phones');

  const keys = new Set();
  let sequence = null;
  const images = [];
  for (const [phoneOrdinal, phone] of payload.phones.entries()) {
    if (!phone || !KEY.test(phone.key) || phone.ordinal !== phoneOrdinal || keys.has(phone.key)) {
      throw new Error(`invalid screenshot phone at ordinal ${phoneOrdinal}`);
    }
    keys.add(phone.key);
    if (!phone.requested || !['preset', 'exact'].includes(phone.requested.kind)) {
      throw new Error(`screenshot phone ${phone.key} has an invalid request`);
    }
    if (!phone.resolved || typeof phone.resolved.model !== 'string' || !phone.resolved.model
        || typeof phone.resolved.runtime !== 'string' || !phone.resolved.runtime) {
      throw new Error(`screenshot phone ${phone.key} has invalid resolved device metadata`);
    }
    const phoneImages = parseImages(phone.screenshots, {
      phoneKey: phone.key, phoneOrdinal, requested: phone.requested,
      resolved: phone.resolved, prefix: `phones/${phone.key}/`, requireDimensions: true,
    });
    const current = phoneImages.map((item) => `${item.ordinal}:${item.name}`);
    if (sequence && (current.length !== sequence.length || current.some((item, index) => item !== sequence[index]))) {
      throw new Error('every screenshot phone must contain the same ordered states');
    }
    sequence = current;
    images.push(...phoneImages);
  }
  if (images.length > 100) throw new Error('a screenshot journey may contain at most 100 images');
  return images;
}

function parseImages(items, phone) {
  if (!Array.isArray(items) || !items.length) throw new Error(`screenshot phone ${phone.phoneKey} has no images`);

  const names = new Set();
  return items.map((item, ordinal) => {
    if (!item || !NAME.test(item.name)) throw new Error(`invalid screenshot name at ordinal ${ordinal}`);
    if (names.has(item.name)) throw new Error(`duplicate screenshot name: ${item.name}`);
    names.add(item.name);
    if (item.ordinal !== ordinal) throw new Error(`screenshot ${item.name} has a non-contiguous ordinal`);
    if (item.filename !== `${phone.prefix}${item.name}.png`) throw new Error(`screenshot ${item.name} has an invalid filename`);
    if (phone.requireDimensions && (!Number.isSafeInteger(item.widthPixels) || item.widthPixels < 1
        || !Number.isSafeInteger(item.heightPixels) || item.heightPixels < 1)) {
      throw new Error(`screenshot ${item.name} has invalid PNG dimensions`);
    }
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 8) {
      throw new Error(`screenshot ${item.name} has an invalid byte count`);
    }
    if (!SHA256.test(item.sha256)) throw new Error(`screenshot ${item.name} has an invalid SHA-256`);
    return {
      ...item,
      phoneKey: phone.phoneKey,
      phoneOrdinal: phone.phoneOrdinal,
      requested: phone.requested,
      resolved: phone.resolved,
      widthPixels: item.widthPixels ?? null,
      heightPixels: item.heightPixels ?? null,
    };
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
    const sourcePath = path.resolve(root, item.filename);
    if (!sourcePath.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`${item.filename} escapes the screenshot bundle`);
    const handle = await fs.promises.open(sourcePath, 'r');
    const header = Buffer.alloc(24);
    try {
      await handle.read(header, 0, header.length, 0);
    } finally {
      await handle.close();
    }
    if (!header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || header.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error(`${item.filename} is not a PNG`);
    }
    const widthPixels = header.readUInt32BE(16);
    const heightPixels = header.readUInt32BE(20);
    if (item.widthPixels !== null && (item.widthPixels !== widthPixels || item.heightPixels !== heightPixels)) {
      throw new Error(`${item.filename} dimensions do not match manifest.json`);
    }
    const sizeBytes = (await fs.promises.stat(sourcePath)).size;
    if (sizeBytes !== item.sizeBytes) throw new Error(`${item.filename} byte count does not match manifest.json`);
    const sha256 = await sha256Of(sourcePath);
    if (sha256 !== item.sha256) throw new Error(`${item.filename} SHA-256 does not match manifest.json`);
    item.widthPixels = widthPixels;
    item.heightPixels = heightPixels;
    item.sourcePath = sourcePath;
  }
  return screenshots;
}
