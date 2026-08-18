import { db, newId, nowIso } from './db.js';

export class ValidationError extends Error {}

export function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'project';
}

function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug)) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Accepts `owner/repo` or a full GitHub URL and normalises to `owner/repo`. */
export function normaliseRepo(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const url = raw.match(/github\.com[/:]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  const value = url ? url[1] : raw.replace(/\.git$/, '');
  if (!REPO_PATTERN.test(value)) {
    throw new ValidationError('GitHub repository must look like `owner/repo`.');
  }
  return value;
}

export function createProject(userId, { name, description, githubRepo, githubRef }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new ValidationError('Give the project a name.');
  if (trimmed.length > 80) throw new ValidationError('Project name must be 80 characters or fewer.');

  const id = newId();
  db.prepare(
    `INSERT INTO projects (id, user_id, slug, name, description, github_repo, github_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, userId, uniqueSlug(slugify(trimmed)), trimmed,
    String(description || '').trim(), normaliseRepo(githubRepo),
    String(githubRef || '').trim(), nowIso(), nowIso(),
  );
  return getProject(id);
}

export function updateProject(projectId, { name, description, githubRepo, githubRef }) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new ValidationError('Give the project a name.');
  db.prepare(
    `UPDATE projects SET name = ?, description = ?, github_repo = ?, github_ref = ?, updated_at = ?
     WHERE id = ?`,
  ).run(trimmed, String(description || '').trim(), normaliseRepo(githubRepo), String(githubRef || '').trim(), nowIso(), projectId);
  return getProject(projectId);
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

/** Projects are addressable by id or slug so CI callers can use readable names. */
export function findProject(userId, identifier) {
  if (!identifier) return null;
  return db.prepare(
    'SELECT * FROM projects WHERE user_id = ? AND (id = ? OR slug = ?)',
  ).get(userId, identifier, identifier);
}

export function listProjects(userId) {
  return db.prepare(
    `SELECT projects.*,
            (SELECT COUNT(*) FROM archives WHERE archives.project_id = projects.id) AS archive_count,
            (SELECT MAX(version) FROM archives WHERE archives.project_id = projects.id) AS latest_version,
            (SELECT status FROM runs WHERE runs.project_id = projects.id ORDER BY number DESC LIMIT 1) AS last_status,
            (SELECT number FROM runs WHERE runs.project_id = projects.id ORDER BY number DESC LIMIT 1) AS last_run_number,
            (SELECT created_at FROM runs WHERE runs.project_id = projects.id ORDER BY number DESC LIMIT 1) AS last_run_at
     FROM projects WHERE user_id = ? ORDER BY updated_at DESC`,
  ).all(userId);
}

export function deleteProject(projectId) {
  db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
}
