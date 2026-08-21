import config from './config.js';
import { db, newId, nowIso } from './db.js';

/**
 * The pipeline is a strict gate sequence: each stage only starts if every
 * earlier stage passed. A failure marks the rest `blocked` — "not reached" —
 * which is materially different from "pending", and the UI renders it so.
 */
export const STAGES = [
  { key: 'flutter_test',  label: 'Flutter tests', hint: 'Unit and widget tests on the Dart VM.' },
  { key: 'ios_build',     label: 'iOS build',     hint: 'Release build plus the XCTest bundle for Test Lab.' },
  { key: 'firebase_test', label: 'Firebase XCTest', hint: 'XCUITest on a physical device via Firebase Test Lab.' },
];

export const STAGE_KEYS = STAGES.map((s) => s.key);
const TERMINAL = new Set(['passed', 'failed', 'error', 'cancelled']);

export const isTerminal = (status) => TERMINAL.has(status);

function nextNumber(projectId) {
  const row = db.prepare('SELECT MAX(number) AS n FROM runs WHERE project_id = ?').get(projectId);
  return (row?.n || 0) + 1;
}

export function createRun({ projectId, archiveId, skipFirebase = false, captureScreenshot = false }) {
  const id = newId();
  const number = nextNumber(projectId);

  const insertRun = db.prepare(
    `INSERT INTO runs
       (id, project_id, archive_id, number, status, stage, skip_firebase, capture_screenshot,
        screenshot_status, created_at)
     VALUES (?, ?, ?, ?, 'queued', '', ?, ?, ?, ?)`,
  );
  const insertStage = db.prepare(
    `INSERT INTO run_stages (id, run_id, key, position, status) VALUES (?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    insertRun.run(
      id,
      projectId,
      archiveId,
      number,
      skipFirebase ? 1 : 0,
      captureScreenshot ? 1 : 0,
      captureScreenshot ? 'pending' : 'not_requested',
      nowIso(),
    );
    STAGES.forEach((stage, index) => {
      const status = stage.key === 'firebase_test' && skipFirebase ? 'skipped' : 'pending';
      insertStage.run(newId(), id, stage.key, index, status);
    });
  })();

  addEvent(id, '', 'info', 'Run queued. Waiting for a GitHub Actions runner to pick it up.');
  return getRun(id);
}

export function getRun(runId) {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
}

export function getRunByNumber(projectId, number) {
  return db.prepare('SELECT * FROM runs WHERE project_id = ? AND number = ?').get(projectId, number);
}

export function getStages(runId) {
  const rows = db.prepare('SELECT * FROM run_stages WHERE run_id = ? ORDER BY position').all(runId);
  return rows.map((row) => ({ ...row, ...STAGES.find((s) => s.key === row.key) }));
}

export function addEvent(runId, stage, level, message) {
  db.prepare('INSERT INTO run_events (run_id, stage, level, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(runId, stage || '', level || 'info', message, nowIso());
}

export function getEvents(runId, sinceId = 0) {
  return db.prepare('SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id').all(runId, sinceId);
}

export function markRunStarted(runId, { ghRunId, ghRunUrl }) {
  const run = getRun(runId);
  if (!run) return null;
  db.prepare(
    `UPDATE runs SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
                     gh_run_id = COALESCE(NULLIF(?, ''), gh_run_id),
                     gh_run_url = COALESCE(NULLIF(?, ''), gh_run_url),
                     started_at = COALESCE(started_at, ?)
     WHERE id = ?`,
  ).run(ghRunId || '', ghRunUrl || '', nowIso(), runId);
  return getRun(runId);
}

/**
 * Applies one stage transition and derives the run's own status from it. This
 * is the only place run status changes, so the gate rule lives in one spot.
 */
export function updateStage(runId, key, status, detail = '') {
  if (!STAGE_KEYS.includes(key)) throw new Error(`Unknown stage \`${key}\`.`);
  const run = getRun(runId);
  if (!run) throw new Error('Run not found.');
  if (isTerminal(run.status)) return getRun(runId);

  const stamp = nowIso();
  db.transaction(() => {
    if (status === 'running') {
      db.prepare('UPDATE run_stages SET status = ?, detail = ?, started_at = COALESCE(started_at, ?) WHERE run_id = ? AND key = ?')
        .run(status, detail, stamp, runId, key);
      db.prepare("UPDATE runs SET stage = ?, status = CASE WHEN status = 'queued' THEN 'running' ELSE status END, started_at = COALESCE(started_at, ?) WHERE id = ?")
        .run(key, stamp, runId);
    } else {
      db.prepare('UPDATE run_stages SET status = ?, detail = ?, finished_at = ? WHERE run_id = ? AND key = ?')
        .run(status, detail, stamp, runId, key);
    }

    if (status === 'failed') {
      // The gate closed: nothing downstream ran, and saying "pending" would lie.
      const position = STAGES.findIndex((s) => s.key === key);
      db.prepare(
        `UPDATE run_stages SET status = 'blocked', detail = 'Not reached — an earlier stage failed.'
         WHERE run_id = ? AND position > ? AND status = 'pending'`,
      ).run(runId, position);
      db.prepare("UPDATE runs SET status = 'failed', failed_stage = ?, summary = ?, finished_at = ? WHERE id = ?")
        .run(key, detail || `${key} failed.`, stamp, runId);
    }
  })();

  return getRun(runId);
}

/** Called by CI at the end of the workflow, and by the reaper on timeout. */
export function finishRun(runId, { status, summary = '' }) {
  const run = getRun(runId);
  if (!run) throw new Error('Run not found.');
  if (isTerminal(run.status)) return run;

  const stamp = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE run_stages SET status = 'blocked', detail = 'Not reached — the run ended first.'
       WHERE run_id = ? AND status IN ('pending', 'running')`,
    ).run(runId);
    db.prepare('UPDATE runs SET status = ?, summary = ?, finished_at = ? WHERE id = ?')
      .run(status, summary, stamp, runId);
  })();

  return getRun(runId);
}

export function addLog(runId, stage, name, content) {
  const id = newId();
  db.prepare('INSERT INTO run_logs (id, run_id, stage, name, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, runId, stage || '', name, content, nowIso());
  return id;
}

export function getLogs(runId) {
  return db.prepare('SELECT id, run_id, stage, name, length(content) AS size, created_at FROM run_logs WHERE run_id = ? ORDER BY created_at').all(runId);
}

export function getLog(logId) {
  return db.prepare('SELECT * FROM run_logs WHERE id = ?').get(logId);
}

export function getArtifacts(runId) {
  return db.prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at').all(runId);
}

export function getScreenshots(runId) {
  const run = getRun(runId);
  if (!run) return null;
  const rows = db.prepare(
    `SELECT id, filename, screenshot_name, screenshot_ordinal, size_bytes, sha256
       FROM artifacts
      WHERE run_id = ? AND kind = 'screenshot'
      ORDER BY screenshot_ordinal, screenshot_name`,
  ).all(runId);
  return {
    status: run.screenshot_status,
    error: run.screenshot_error || null,
    startedAt: run.screenshot_started_at,
    finishedAt: run.screenshot_finished_at,
    items: rows.map((row) => ({
      artifactId: row.id,
      name: row.screenshot_name || row.filename.replace(/\.png$/i, ''),
      ordinal: row.screenshot_ordinal,
      filename: row.filename,
      sizeBytes: row.size_bytes,
      sha256: row.sha256,
    })),
  };
}

export function beginScreenshotIngestion(runId) {
  const stamp = nowIso();
  const result = db.prepare(
    `UPDATE runs
        SET screenshot_status = 'ingesting', screenshot_error = '',
            screenshot_started_at = ?, screenshot_finished_at = NULL
      WHERE id = ? AND capture_screenshot = 1 AND screenshot_status IN ('pending', 'failed')`,
  ).run(stamp, runId);
  return { claimed: result.changes === 1, screenshots: getScreenshots(runId) };
}

export function completeScreenshotIngestion(runId, artifacts) {
  const stamp = nowIso();
  db.transaction(() => {
    const run = getRun(runId);
    if (!run || run.screenshot_status !== 'ingesting') {
      throw new Error('Screenshot ingestion is no longer active.');
    }
    const insert = db.prepare(
      `INSERT INTO artifacts
         (id, run_id, kind, filename, storage_path, size_bytes, sha256,
          screenshot_name, screenshot_ordinal, created_at)
       VALUES (?, ?, 'screenshot', ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const artifact of artifacts) {
      insert.run(
        artifact.id, runId, artifact.filename, artifact.storagePath,
        artifact.sizeBytes, artifact.sha256, artifact.name, artifact.ordinal, stamp,
      );
    }
    db.prepare(
      `UPDATE runs SET screenshot_status = 'ready', screenshot_error = '', screenshot_finished_at = ?
        WHERE id = ?`,
    ).run(stamp, runId);
  })();
  return getScreenshots(runId);
}

export function failScreenshotIngestion(runId, message) {
  db.prepare(
    `UPDATE runs SET screenshot_status = 'failed', screenshot_error = ?, screenshot_finished_at = ?
      WHERE id = ? AND screenshot_status = 'ingesting'`,
  ).run(String(message).slice(0, 1000), nowIso(), runId);
  return getScreenshots(runId);
}

export function listRuns(projectId, limit = 25) {
  return db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY number DESC LIMIT ?').all(projectId, limit);
}

export function activeRun(projectId) {
  return db.prepare("SELECT * FROM runs WHERE project_id = ? AND status IN ('queued','running') ORDER BY number DESC LIMIT 1").get(projectId);
}

/**
 * Firebase Test Lab's free tier allows 5 physical-device tests per day. Runs
 * are counted rather than reserved, so a run that never reaches the stage does
 * not consume budget.
 */
export function firebaseUsageToday(userId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM run_stages
     JOIN runs ON runs.id = run_stages.run_id
     JOIN projects ON projects.id = runs.project_id
     WHERE projects.user_id = ?
       AND run_stages.key = 'firebase_test'
       AND run_stages.status IN ('running', 'passed', 'failed')
       AND run_stages.started_at >= ?`,
  ).get(userId, since);
  return { used: row?.n || 0, quota: config.firebaseDailyQuota };
}

/** Runs that never reported back get closed out rather than spinning forever. */
export function reapStaleRuns(maxAgeMs = 2 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = db.prepare("SELECT id FROM runs WHERE status IN ('queued','running') AND created_at < ?").all(cutoff);
  for (const { id } of stale) {
    addEvent(id, '', 'error', 'No status received for two hours. Marking the run as errored.');
    finishRun(id, { status: 'error', summary: 'Timed out waiting for the CI runner to report.' });
  }
  return stale.length;
}
