import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import config from './config.js';
import { hashPassword } from './crypto.js';
import { log } from './log.js';

for (const dir of [config.dataDir, config.archiveDir, config.artifactDir, config.tmpDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  github_token  TEXT,
  github_login  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  github_repo TEXT NOT NULL DEFAULT '',
  github_ref  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Every upload or GitHub resync produces one immutable archive version.
CREATE TABLE IF NOT EXISTS archives (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  source        TEXT NOT NULL,               -- upload | github
  filename      TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  format        TEXT NOT NULL,               -- tar.gz | zip
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  root_prefix   TEXT NOT NULL DEFAULT '',    -- leading dir to strip on extract
  commit_sha    TEXT NOT NULL DEFAULT '',
  git_ref       TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  archive_id    TEXT REFERENCES archives(id) ON DELETE SET NULL,
  number        INTEGER NOT NULL,
  status        TEXT NOT NULL,               -- queued|running|passed|failed|error|cancelled
  stage         TEXT NOT NULL DEFAULT '',    -- flutter_test|ios_build|firebase_test
  failed_stage  TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  skip_firebase INTEGER NOT NULL DEFAULT 0,
  gh_run_id     TEXT NOT NULL DEFAULT '',
  gh_run_url    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  UNIQUE (project_id, number)
);

-- One row per stage per run: the gated pipeline the UI renders.
CREATE TABLE IF NOT EXISTS run_stages (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  position    INTEGER NOT NULL,
  status      TEXT NOT NULL,                 -- pending|running|passed|failed|skipped|blocked
  detail      TEXT NOT NULL DEFAULT '',
  started_at  TEXT,
  finished_at TEXT,
  UNIQUE (run_id, key)
);

CREATE TABLE IF NOT EXISTS run_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage    TEXT NOT NULL DEFAULT '',
  level    TEXT NOT NULL DEFAULT 'info',     -- info | warn | error | success
  message  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_logs (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage      TEXT NOT NULL,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                -- ios-app | ios-tests | other
  filename     TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- The private key CI uses to reach project archives.
CREATE TABLE IF NOT EXISTS ci_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user    ON projects(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_archives_project ON archives(project_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_runs_project     ON runs(project_id, number DESC);
CREATE INDEX IF NOT EXISTS idx_events_run       ON run_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_stages_run       ON run_stages(run_id, position);
CREATE INDEX IF NOT EXISTS idx_artifacts_run    ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

/**
 * Creates the operator account on first boot. On later boots the password is
 * re-applied so rotating ADMIN_PASSWORD in Compose actually takes effect.
 */
export function seedAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(config.adminUsername);
  const hash = hashPassword(config.adminPassword);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hash, nowIso(), existing.id);
    log.info('seed: admin password synced', { username: config.adminUsername });
    return existing.id;
  }
  const id = newId();
  db.prepare(`INSERT INTO users (id, username, password_hash, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(id, config.adminUsername, hash, nowIso(), nowIso());
  log.info('seed: admin created', { username: config.adminUsername });
  return id;
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}

export default db;
