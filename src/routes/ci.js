import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import multer from 'multer';
import config from '../config.js';
import { db, newId, nowIso } from '../db.js';
import { requireCiKey } from '../auth.js';
import { findProject, getProject } from '../projects.js';
import { latestArchive, latestArchiveForUser, sha256Of } from '../archives.js';
import {
  getRun, getStages, updateStage, addEvent, addLog, finishRun,
  markRunStarted, beginScreenshotIngestion, completeScreenshotIngestion,
  failScreenshotIngestion, STAGE_KEYS, isTerminal,
} from '../runs.js';
import { validateScreenshotBundle } from '../screenshots.js';
import * as github from '../github.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

const upload = multer({
  dest: config.tmpDir,
  limits: { fileSize: config.maxUploadBytes },
});

export const ciRouter = express.Router();
ciRouter.use(requireCiKey);
ciRouter.use(express.json({ limit: '2mb' }));
ciRouter.use(express.text({ type: 'text/*', limit: '16mb' }));

function archiveResponse(project, archive) {
  return {
    project: { id: project.id, slug: project.slug, name: project.name, githubRepo: project.github_repo },
    archive: {
      id: archive.id,
      version: archive.version,
      source: archive.source,
      format: archive.format,
      filename: archive.filename,
      sizeBytes: archive.size_bytes,
      sha256: archive.sha256,
      rootPrefix: archive.root_prefix,
      commitSha: archive.commit_sha,
      gitRef: archive.git_ref,
      createdAt: archive.created_at,
      downloadUrl: `${config.publicUrl}/api/v1/ci/archive?archive=${archive.id}`,
    },
  };
}

/**
 * Resolves what the runner should build. Order of precedence: an explicit
 * archive, a run's pinned archive, a named project's newest archive, and
 * finally — when nothing is named — the newest archive the key's owner has.
 */
function resolveTarget(req) {
  const { archive: archiveId, run: runId, project: projectRef, version } = req.query;

  if (archiveId) {
    const archive = db.prepare('SELECT * FROM archives WHERE id = ?').get(archiveId);
    if (!archive) return { error: 'Archive not found.' };
    const project = getProject(archive.project_id);
    if (!project || project.user_id !== req.user.id) return { error: 'Archive not found.' };
    return { project, archive };
  }

  if (runId) {
    const run = getRun(runId);
    if (!run) return { error: 'Run not found.' };
    const project = getProject(run.project_id);
    if (!project || project.user_id !== req.user.id) return { error: 'Run not found.' };
    const archive = run.archive_id
      ? db.prepare('SELECT * FROM archives WHERE id = ?').get(run.archive_id)
      : latestArchive(project.id);
    if (!archive) return { error: 'This run has no archive attached.' };
    return { project, archive, run };
  }

  if (projectRef) {
    const project = findProject(req.user.id, projectRef);
    if (!project) return { error: `No project matches \`${projectRef}\`.` };
    const archive = version
      ? db.prepare('SELECT * FROM archives WHERE project_id = ? AND version = ?').get(project.id, Number(version))
      : latestArchive(project.id);
    if (!archive) return { error: 'That project has no archives yet.' };
    return { project, archive };
  }

  const archive = latestArchiveForUser(req.user.id);
  if (!archive) return { error: 'No archives have been uploaded yet.' };
  return { project: getProject(archive.project_id), archive };
}

// ── Discovery ───────────────────────────────────────────────────────────────

ciRouter.get('/whoami', (req, res) => {
  res.json({ user: req.user.username, key: { name: req.ciKey.name, prefix: req.ciKey.prefix } });
});

ciRouter.get('/resolve', (req, res) => {
  const target = resolveTarget(req);
  if (target.error) return res.status(404).json({ error: target.error });

  const payload = archiveResponse(target.project, target.archive);
  if (target.run) {
    payload.run = {
      id: target.run.id,
      number: target.run.number,
      status: target.run.status,
      skipFirebase: Boolean(target.run.skip_firebase),
      captureScreenshot: Boolean(target.run.capture_screenshot),
    };
  }
  res.json(payload);
});

ciRouter.get('/archive', (req, res) => {
  const target = resolveTarget(req);
  if (target.error) return res.status(404).json({ error: target.error });

  const { archive } = target;
  if (!fs.existsSync(archive.storage_path)) {
    log.error('ci: archive file missing', { archiveId: archive.id, path: archive.storage_path });
    return res.status(410).json({ error: 'The archive file is no longer on disk.' });
  }

  const ext = archive.format === 'zip' ? 'zip' : 'tar.gz';
  res.setHeader('Content-Type', archive.format === 'zip' ? 'application/zip' : 'application/gzip');
  res.setHeader('Content-Length', archive.size_bytes);
  res.setHeader('X-AppRunner-Archive-Id', archive.id);
  res.setHeader('X-AppRunner-Archive-Version', String(archive.version));
  res.setHeader('X-AppRunner-Archive-Format', archive.format);
  res.setHeader('X-AppRunner-Root-Prefix', archive.root_prefix || '');
  res.setHeader('X-AppRunner-Sha256', archive.sha256);
  res.setHeader('X-AppRunner-Project', target.project.slug);
  res.setHeader('Content-Disposition', `attachment; filename="${target.project.slug}-v${archive.version}.${ext}"`);
  fs.createReadStream(archive.storage_path).pipe(res);
});

// ── Run reporting ───────────────────────────────────────────────────────────

/** Loads the run and proves the CI key's owner also owns it. */
function loadOwnedRun(req, res) {
  const run = getRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: 'Run not found.' });
    return null;
  }
  const project = getProject(run.project_id);
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: 'Run not found.' });
    return null;
  }
  req.project = project;
  return run;
}

ciRouter.get('/runs/:runId', (req, res) => {
  const run = loadOwnedRun(req, res);
  if (!run) return;
  res.json({
    run: {
      id: run.id, number: run.number, status: run.status, stage: run.stage,
      skipFirebase: Boolean(run.skip_firebase),
      captureScreenshot: Boolean(run.capture_screenshot),
    },
    project: { id: req.project.id, slug: req.project.slug, name: req.project.name },
    stages: getStages(run.id).map((s) => ({ key: s.key, status: s.status, detail: s.detail })),
  });
});

ciRouter.post('/runs/:runId/start', (req, res) => {
  const run = loadOwnedRun(req, res);
  if (!run) return;
  const { gh_run_id: ghRunId = '', gh_run_url: ghRunUrl = '' } = req.body || {};
  const updated = markRunStarted(run.id, { ghRunId: String(ghRunId), ghRunUrl: String(ghRunUrl) });
  addEvent(run.id, '', 'info', 'Runner picked up the job.');
  res.json({ ok: true, status: updated.status });
});

ciRouter.post('/runs/:runId/stage', (req, res) => {
  const run = loadOwnedRun(req, res);
  if (!run) return;

  const { stage, status, detail = '' } = req.body || {};
  if (!STAGE_KEYS.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of ${STAGE_KEYS.join(', ')}.` });
  }
  if (!['running', 'passed', 'failed', 'skipped'].includes(status)) {
    return res.status(400).json({ error: 'status must be running, passed, failed, or skipped.' });
  }

  const updated = updateStage(run.id, stage, status, String(detail).slice(0, 500));
  const level = status === 'failed' ? 'error' : status === 'passed' ? 'success' : 'info';
  addEvent(run.id, stage, level, `${stage}: ${status}${detail ? ` — ${detail}` : ''}`);
  res.json({ ok: true, runStatus: updated.status });
});

ciRouter.post('/runs/:runId/events', (req, res) => {
  const run = loadOwnedRun(req, res);
  if (!run) return;
  const { message, stage = '', level = 'info' } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message is required.' });
  addEvent(run.id, String(stage), ['info', 'warn', 'error', 'success'].includes(level) ? level : 'info', String(message).slice(0, 2000));
  res.json({ ok: true });
});

ciRouter.post('/runs/:runId/logs', upload.single('file'), async (req, res) => {
  const run = loadOwnedRun(req, res);
  if (!run) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return;
  }

  const stage = String(req.query.stage || req.body?.stage || '');
  const name = String(req.query.name || req.body?.name || req.file?.originalname || 'output.log');

  let content = '';
  if (req.file) {
    content = await fs.promises.readFile(req.file.path, 'utf8');
    await fs.promises.unlink(req.file.path).catch(() => {});
  } else if (typeof req.body === 'string') {
    content = req.body;
  } else if (req.body?.content) {
    content = String(req.body.content);
  }

  if (!content.trim()) return res.status(400).json({ error: 'Log content is empty.' });

  // Keep the tail: failures are almost always at the end of a build log.
  const MAX = 1024 * 1024;
  if (content.length > MAX) {
    content = `… ${content.length - MAX} earlier characters trimmed …\n` + content.slice(-MAX);
  }

  const id = addLog(run.id, stage, name, content);
  res.json({ ok: true, id });
});

ciRouter.post('/runs/:runId/artifacts', upload.single('file'), async (req, res) => {
  const run = loadOwnedRun(req, res);
  if (!run) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return;
  }
  if (!req.file) return res.status(400).json({ error: 'Attach the artifact as `file`.' });

  const kind = String(req.query.kind || req.body?.kind || 'other');
  const filename = path.basename(String(req.query.filename || req.body?.filename || req.file.originalname || 'artifact.zip'));

  const dir = path.join(config.artifactDir, run.id);
  await fs.promises.mkdir(dir, { recursive: true });
  const id = newId();
  const storagePath = path.join(dir, `${id}-${filename}`);
  await fs.promises.rename(req.file.path, storagePath);

  const sha256 = await sha256Of(storagePath);
  const size = (await fs.promises.stat(storagePath)).size;

  db.prepare(
    `INSERT INTO artifacts (id, run_id, kind, filename, storage_path, size_bytes, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, run.id, kind, filename, storagePath, size, sha256, nowIso());

  addEvent(run.id, kind, 'success', `Uploaded ${filename} (${(size / 1048576).toFixed(1)} MB).`);
  res.json({ ok: true, id, sha256, sizeBytes: size });
});

/**
 * Pulls build output from GitHub Actions instead of receiving a push.
 *
 * Uploading from a runner to this host runs at 5-57 KB/s, while this host pulls
 * from GitHub at ~285 KB/s, so the transfer is inverted. Responds immediately
 * and fetches in the background: the download outlives the workflow step, and
 * holding the request open would just reintroduce a long-lived connection.
 */
ciRouter.post('/runs/:runId/artifacts/from-github', (req, res) => {
  const run = loadOwnedRun(req, res);
  if (!run) return;

  const { github_run_id: ghRunId, name, kind = 'ios-app', filename } = req.body || {};
  if (!ghRunId || !name) {
    return res.status(400).json({ error: 'github_run_id and name are required.' });
  }

  if (kind === 'screenshot') {
    const claim = beginScreenshotIngestion(run.id);
    if (!claim.claimed) {
      const status = claim.screenshots?.status;
      const code = status === 'ready' ? 200 : status === 'ingesting' ? 202 : 409;
      return res.status(code).json({ ok: code !== 409, screenshots: claim.screenshots });
    }
  }

  res.status(202).json({ ok: true, fetching: { githubRunId: String(ghRunId), name } });

  // Deliberately not awaited: the response is already sent.
  const ingest = kind === 'screenshot' ? ingestGithubScreenshots : ingestGithubArtifact;
  ingest(run, { ghRunId: String(ghRunId), name, kind, filename })
    .catch((err) => {
      log.error('github artifact ingest failed', { runId: run.id, error: err.message });
      addEvent(run.id, kind, 'error', `Could not fetch ${name} from GitHub: ${err.message}`);
      if (kind === 'screenshot') failScreenshotIngestion(run.id, err.message);
    });
});

async function ingestGithubScreenshots(run, { ghRunId, name }) {
  const started = Date.now();
  const { zipPath } = await github.downloadWorkflowArtifact({ runId: ghRunId, name });
  const workDir = path.join(config.tmpDir, `gha-screenshots-${newId()}`);
  const moved = [];
  let committed = false;
  try {
    await fs.promises.mkdir(workDir, { recursive: true });
    await execFileAsync('unzip', ['-qq', '-o', zipPath, '-d', workDir]);
    const screenshots = await validateScreenshotBundle(workDir, sha256Of);
    const dir = path.join(config.artifactDir, run.id);
    await fs.promises.mkdir(dir, { recursive: true });

    const artifacts = [];
    for (const screenshot of screenshots) {
      const id = newId();
      const storagePath = path.join(dir, `${id}-${screenshot.filename}`);
      await fs.promises.rename(screenshot.sourcePath, storagePath);
      moved.push(storagePath);
      artifacts.push({ id, storagePath, ...screenshot });
    }
    completeScreenshotIngestion(run.id, artifacts);
    committed = true;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    try {
      addEvent(run.id, 'screenshot', 'success', `Pulled ${artifacts.length} screenshots from GitHub in ${seconds}s.`);
    } catch (err) {
      log.warn('could not record screenshot ingest event', { runId: run.id, error: err.message });
    }
    log.info('github screenshots ingested', { runId: run.id, count: artifacts.length, seconds });
  } catch (err) {
    if (!committed) {
      await Promise.all(moved.map((file) => fs.promises.rm(file, { force: true }).catch(() => {})));
    }
    throw err;
  } finally {
    await fs.promises.rm(zipPath, { force: true }).catch(() => {});
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ingestGithubArtifact(run, { ghRunId, name, kind, filename }) {
  const started = Date.now();
  const { zipPath } = await github.downloadWorkflowArtifact({ runId: ghRunId, name });

  const workDir = path.join(config.tmpDir, `gha-${newId()}`);
  try {
    await fs.promises.mkdir(workDir, { recursive: true });
    // Actions always wraps uploads in a zip, whatever was put in.
    await execFileAsync('unzip', ['-qq', '-o', zipPath, '-d', workDir]);

    const entries = (await fs.promises.readdir(workDir, { withFileTypes: true }))
      .filter((e) => e.isFile());
    if (!entries.length) throw new Error('the artifact archive contained no file');

    // The archive may hold several outputs; pick the requested one rather than
    // whichever readdir happened to return first, or the rename would mislabel
    // one file as another.
    const wanted = filename ? path.basename(filename) : '';
    const chosen = entries.find((e) => e.name === wanted) || entries[0];
    if (wanted && chosen.name !== wanted) {
      log.warn('requested artifact not in archive; using what was found', {
        runId: run.id, wanted, using: chosen.name,
      });
    }

    const extracted = path.join(workDir, chosen.name);
    const finalName = chosen.name;

    const dir = path.join(config.artifactDir, run.id);
    await fs.promises.mkdir(dir, { recursive: true });
    const id = newId();
    const storagePath = path.join(dir, `${id}-${finalName}`);
    await fs.promises.rename(extracted, storagePath);

    const sha256 = await sha256Of(storagePath);
    const size = (await fs.promises.stat(storagePath)).size;

    db.prepare(
      `INSERT INTO artifacts (id, run_id, kind, filename, storage_path, size_bytes, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, run.id, kind, finalName, storagePath, size, sha256, nowIso());

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    addEvent(run.id, kind, 'success', `Pulled ${finalName} from GitHub (${(size / 1048576).toFixed(1)} MB in ${seconds}s).`);
    log.info('github artifact ingested', { runId: run.id, filename: finalName, size, seconds });
  } finally {
    await fs.promises.rm(zipPath, { force: true }).catch(() => {});
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

ciRouter.post('/runs/:runId/finish', (req, res) => {
  const run = loadOwnedRun(req, res);
  if (!run) return;

  const { status = 'passed', summary = '' } = req.body || {};
  if (!['passed', 'failed', 'error', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'status must be passed, failed, error, or cancelled.' });
  }

  if (isTerminal(run.status)) return res.json({ ok: true, status: run.status, note: 'Run was already finished.' });

  addEvent(run.id, '', status === 'passed' ? 'success' : 'error', summary || `Run ${status}.`);
  const updated = finishRun(run.id, { status, summary: String(summary).slice(0, 500) });
  res.json({ ok: true, status: updated.status });
});

export default ciRouter;
