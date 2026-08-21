const PRESETS = new Set(['default', 'compact', 'standard', 'large']);
const KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RUNTIME = /^\d+\.\d+$/;

export function phoneKey(phone) {
  return typeof phone === 'string' ? phone : phone.key;
}

export function manifestRequest(phone) {
  if (typeof phone === 'string') return { kind: 'preset', preset: phone };
  return {
    kind: 'exact',
    model: phone.model,
    ...(phone.runtime ? { runtime: phone.runtime } : {}),
  };
}

export function screenshotPhoneRecords(phones) {
  return phones.map((phone, ordinal) => ({
    key: phoneKey(phone),
    ordinal,
    requested: manifestRequest(phone),
  }));
}

export function assertScreenshotManifestMatchesRequest(phones, images) {
  const expected = screenshotPhoneRecords(phones);
  const actual = [];
  for (const image of images) {
    if (!actual.some((phone) => phone.key === image.phoneKey)) {
      actual.push({ key: image.phoneKey, ordinal: image.phoneOrdinal, requested: image.requested });
    }
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('manifest.json phones do not match the run screenshot request');
  }
}

export function normalizeScreenshotPhones(value) {
  const phones = value === undefined ? ['default'] : value;
  if (!Array.isArray(phones) || phones.length < 1 || phones.length > 4) {
    throw new Error('screenshotPhones must contain between one and four phones.');
  }
  const keys = new Set();
  return phones.map((phone, ordinal) => {
    let normalized;
    if (typeof phone === 'string') {
      if (!PRESETS.has(phone)) throw new Error(`Unknown screenshot phone preset \`${phone}\`.`);
      normalized = phone;
    } else if (phone && typeof phone === 'object' && !Array.isArray(phone)) {
      const key = typeof phone.key === 'string' ? phone.key : '';
      const model = typeof phone.model === 'string' ? phone.model.trim() : '';
      if (!KEY.test(key)) throw new Error(`Invalid screenshot phone key at ordinal ${ordinal}.`);
      if (!model || model.length > 100) throw new Error(`Exact screenshot phone \`${key}\` needs a model.`);
      if (phone.runtime !== undefined && (typeof phone.runtime !== 'string' || !RUNTIME.test(phone.runtime))) {
        throw new Error(`Exact screenshot phone \`${key}\` has an invalid runtime.`);
      }
      normalized = { key, model, ...(phone.runtime ? { runtime: phone.runtime } : {}) };
    } else {
      throw new Error(`Invalid screenshot phone at ordinal ${ordinal}.`);
    }
    const key = phoneKey(normalized);
    if (keys.has(key)) throw new Error(`duplicate screenshot phone key: ${key}`);
    keys.add(key);
    return normalized;
  });
}
