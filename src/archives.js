import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import config from './config.js';
import { db, newId, nowIso } from './db.js';

const run = promisify(execFile);

export class ArchiveError extends Error {}

const FORMATS = [
  { ext: '.tar.gz', format: 'tar.gz' },
  { ext: '.tgz', format: 'tar.gz' },
  { ext: '.zip', format: 'zip' },
];

export function detectFormat(filename) {
  const lower = String(filename || '').toLowerCase();
  const match = FORMATS.find((f) => lower.endsWith(f.ext));
  if (!match) {
    throw new ArchiveError('Archive must be a .tar.gz, .tgz, or .zip file.');
  }
  return match.format;
}

async function listEntries(filePath, format) {
  try {
    const { stdout } =
      format === 'zip'
        ? await run('unzip', ['-Z1', filePath], { maxBuffer: 32 * 1024 * 1024 })
        : await run('tar', ['-tzf', filePath], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    throw new ArchiveError('Archive could not be read. It may be corrupt or not the format its name claims.');
  }
}

/**
 * Archives arrive two ways: a browser upload of whatever the user zipped, and
 * a GitHub tarball that always nests everything under `repo-<sha>/`. Recording
 * the shared prefix lets CI extract both with the same command.
 */
function commonPrefix(entries) {
  const tops = new Set(entries.map((e) => e.replace(/^\.\//, '').split('/')[0]).filter(Boolean));
  if (tops.size !== 1) return '';
  const only = [...tops][0];
  const isDir = entries.some((e) => e.replace(/^\.\//, '').startsWith(`${only}/`));
  return isDir ? only : '';
}

/** Verifies the archive holds a Flutter project and reports how to unwrap it. */
export async function inspectArchive(filePath, format) {
  const entries = await listEntries(filePath, format);
  if (entries.length === 0) throw new ArchiveError('Archive is empty.');

  const rootPrefix = commonPrefix(entries);
  const relative = entries.map((e) => {
    const clean = e.replace(/^\.\//, '');
    return rootPrefix && clean.startsWith(`${rootPrefix}/`) ? clean.slice(rootPrefix.length + 1) : clean;
  });

  if (!relative.includes('pubspec.yaml')) {
    throw new ArchiveError(
      'No pubspec.yaml at the archive root. Archive the Flutter project directory itself, not its parent.',
    );
  }

  return {
    rootPrefix,
    entryCount: entries.length,
    hasTests: relative.some((p) => p.startsWith('test/') && p.endsWith('.dart')),
    hasIntegrationTests: relative.some((p) => p.startsWith('integration_test/') && p.endsWith('.dart')),
    hasIosProject: relative.some((p) => p.startsWith('ios/')),
  };
}

export function sha256Of(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function nextVersion(projectId) {
  const row = db.prepare('SELECT MAX(version) AS v FROM archives WHERE project_id = ?').get(projectId);
  return (row?.v || 0) + 1;
}

/**
 * Moves a validated temp file into permanent storage and records the version.
 * The DB row is written only after the file is in place, so a crash mid-store
 * leaves an orphan file rather than a row pointing at nothing.
 */
export async function storeArchive({ projectId, source, filename, tmpPath, commitSha = '', gitRef = '', note = '' }) {
  const format = detectFormat(filename);
  const info = await inspectArchive(tmpPath, format);
  const sha256 = await sha256Of(tmpPath);
  const size = fs.statSync(tmpPath).size;

  const version = nextVersion(projectId);
  const id = newId();
  const ext = format === 'zip' ? 'zip' : 'tar.gz';
  const dir = path.join(config.archiveDir, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const storagePath = path.join(dir, `v${version}-${id}.${ext}`);

  fs.renameSync(tmpPath, storagePath);

  db.prepare(
    `INSERT INTO archives
       (id, project_id, version, source, filename, storage_path, format,
        size_bytes, sha256, root_prefix, commit_sha, git_ref, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, version, source, filename, storagePath, format,
        size, sha256, info.rootPrefix, commitSha, gitRef, note, nowIso());

  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(nowIso(), projectId);

  return { id, version, format, size, sha256, ...info };
}

export function latestArchive(projectId) {
  return db.prepare('SELECT * FROM archives WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId);
}

/** Backs the "no project identifier given" case: newest archive the user owns. */
export function latestArchiveForUser(userId) {
  return db.prepare(
    `SELECT archives.* FROM archives
     JOIN projects ON projects.id = archives.project_id
     WHERE projects.user_id = ?
     ORDER BY archives.created_at DESC LIMIT 1`,
  ).get(userId);
}

export function deleteArchiveFile(archive) {
  try {
    fs.unlinkSync(archive.storage_path);
  } catch { /* already gone */ }
}
