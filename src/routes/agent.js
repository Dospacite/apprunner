import fs from 'node:fs';
import express from 'express';
import multer from 'multer';
import config from '../config.js';
import { db } from '../db.js';
import { requireAgentKey } from '../auth.js';
import {
  createProject, updateProject, findProject, listProjects, ValidationError,
} from '../projects.js';
import { storeArchive, latestArchive, ArchiveError } from '../archives.js';
import {
  createRun, getRun, getStages, getEvents, getLogs, getLog,
  getArtifacts, getScreenshots, listRuns, activeRun, firebaseUsageToday, finishRun, addEvent, isTerminal,
} from '../runs.js';
import * as github from '../github.js';
import { log } from '../log.js';
import { normalizeScreenshotPhones } from '../screenshot-phones.js';

const upload = multer({ dest: config.tmpDir, limits: { fileSize: config.maxUploadBytes } });

/**
 * The API an agent drives: everything the browser can do, minus account
 * settings. Gated behind an agent key so the narrower CI key that lives in a
 * public repository cannot create projects or spend Test Lab quota.
 */
export const agentRouter = express.Router();
agentRouter.use(requireAgentKey);
agentRouter.use(express.json({ limit: '1mb' }));

function serializeProject(project) {
  const latest = latestArchive(project.id);
  const recent = listRuns(project.id, 1)[0];
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    githubRepo: project.github_repo,
    githubRef: project.github_ref,
    latestVersion: latest ? latest.version : null,
    latestArchiveAt: latest ? latest.created_at : null,
    lastRun: recent ? { number: recent.number, status: recent.status, id: recent.id } : null,
    updatedAt: project.updated_at,
  };
}

function serializeRun(run) {
  const stages = getStages(run.id);
  return {
    id: run.id,
    number: run.number,
    projectId: run.project_id,
    status: run.status,
    stage: run.stage,
    failedStage: run.failed_stage || null,
    summary: run.summary,
    captureScreenshot: Boolean(run.capture_screenshot),
    screenshots: getScreenshots(run.id),
    done: isTerminal(run.status),
    githubRunUrl: run.gh_run_url || null,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    stages: stages.map((s) => ({
      key: s.key,
      label: s.label,
      status: s.status,
      detail: s.detail,
      startedAt: s.started_at,
      finishedAt: s.finished_at,
    })),
  };
}

/** Resolves a project by slug or id, scoped to the key's owner. */
function ownProject(req, res) {
  const project = findProject(req.user.id, req.params.ref);
  if (!project) {
    res.status(404).json({ error: `No project matches \`${req.params.ref}\`.` });
    return null;
  }
  return project;
}

function ownRun(req, res) {
  const run = db.prepare(
    `SELECT runs.* FROM runs JOIN projects ON projects.id = runs.project_id
     WHERE runs.id = ? AND projects.user_id = ?`,
  ).get(req.params.runId, req.user.id);
  if (!run) {
    res.status(404).json({ error: 'Run not found.' });
    return null;
  }
  return run;
}

// ── Projects ────────────────────────────────────────────────────────────────

agentRouter.get('/projects', (req, res) => {
  res.json({ projects: listProjects(req.user.id).map(serializeProject) });
});

agentRouter.post('/projects', (req, res) => {
  try {
    const project = createProject(req.user.id, {
      name: req.body.name,
      description: req.body.description,
      githubRepo: req.body.githubRepo,
      githubRef: req.body.githubRef,
    });
    res.status(201).json({ project: serializeProject(project) });
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

agentRouter.get('/projects/:ref', (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;
  res.json({
    project: serializeProject(project),
    archives: db.prepare('SELECT * FROM archives WHERE project_id = ? ORDER BY version DESC LIMIT 20')
      .all(project.id)
      .map((a) => ({
        id: a.id, version: a.version, source: a.source, sizeBytes: a.size_bytes,
        sha256: a.sha256, commitSha: a.commit_sha, createdAt: a.created_at,
      })),
    runs: listRuns(project.id, 10).map((r) => ({
      id: r.id, number: r.number, status: r.status, summary: r.summary, createdAt: r.created_at,
    })),
  });
});

agentRouter.patch('/projects/:ref', (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;
  try {
    const updated = updateProject(project.id, {
      name: req.body.name ?? project.name,
      description: req.body.description ?? project.description,
      githubRepo: req.body.githubRepo ?? project.github_repo,
      githubRef: req.body.githubRef ?? project.github_ref,
    });
    res.json({ project: serializeProject(updated) });
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

// ── Archives ────────────────────────────────────────────────────────────────

agentRouter.post('/projects/:ref/archives', upload.single('file'), async (req, res) => {
  const project = ownProject(req, res);
  if (!project) {
    if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
    return;
  }
  if (!req.file) return res.status(400).json({ error: 'Attach the archive as `file`.' });

  try {
    const stored = await storeArchive({
      projectId: project.id,
      source: 'upload',
      filename: req.file.originalname || 'upload.tar.gz',
      tmpPath: req.file.path,
      note: 'Uploaded by an agent.',
    });
    res.status(201).json({
      archive: {
        id: stored.id, version: stored.version, sizeBytes: stored.size, sha256: stored.sha256,
      },
      // Surfaced so an agent can tell the operator what the pipeline will and
      // will not be able to exercise before it spends a run on it.
      checks: {
        hasTests: stored.hasTests,
        hasIntegrationTests: stored.hasIntegrationTests,
        hasIosProject: stored.hasIosProject,
      },
    });
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    if (!(err instanceof ArchiveError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

agentRouter.post('/projects/:ref/resync', async (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;
  if (!project.github_repo) return res.status(400).json({ error: 'This project has no GitHub repository set.' });

  const token = github.getUserToken(req.user.id);
  if (!token) return res.status(400).json({ error: 'No GitHub account is connected.' });

  let tmpPath = null;
  try {
    const repo = await github.getRepo(token, project.github_repo);
    const ref = project.github_ref || repo.default_branch;
    const commit = await github.resolveCommit(token, project.github_repo, ref);
    tmpPath = await github.downloadTarball(token, project.github_repo, ref);

    const stored = await storeArchive({
      projectId: project.id,
      source: 'github',
      filename: `${project.slug}-${commit.sha.slice(0, 7)}.tar.gz`,
      tmpPath,
      commitSha: commit.sha,
      gitRef: ref,
      note: commit.message,
    });
    tmpPath = null;
    res.status(201).json({
      archive: { id: stored.id, version: stored.version, commitSha: commit.sha, gitRef: ref },
    });
  } catch (err) {
    if (tmpPath) await fs.promises.unlink(tmpPath).catch(() => {});
    if (err instanceof github.GitHubError || err instanceof ArchiveError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
});

// ── Runs ────────────────────────────────────────────────────────────────────

agentRouter.post('/projects/:ref/runs', async (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;

  const latest = latestArchive(project.id);
  if (!latest) return res.status(400).json({ error: 'This project has no archives yet.' });

  const existing = activeRun(project.id);
  if (existing) {
    return res.status(409).json({
      error: `Run #${existing.number} is already in flight.`,
      run: serializeRun(existing),
    });
  }

  const quota = firebaseUsageToday(req.user.id);
  const skipFirebase = Boolean(req.body.skipFirebase) || quota.used >= quota.quota;
  const captureScreenshot = Boolean(req.body.captureScreenshot);
  let screenshotPhones;
  try {
    if (!captureScreenshot && req.body.screenshotPhones !== undefined) {
      throw new Error('screenshotPhones requires captureScreenshot: true.');
    }
    screenshotPhones = captureScreenshot ? normalizeScreenshotPhones(req.body.screenshotPhones) : [];
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const run = createRun({
    projectId: project.id,
    archiveId: latest.id,
    skipFirebase,
    captureScreenshot,
    screenshotPhones,
  });
  if (skipFirebase && quota.used >= quota.quota) {
    addEvent(run.id, 'firebase_test', 'warn', `Firebase stage skipped: daily limit reached (${quota.used}/${quota.quota}).`);
  }

  try {
    await github.dispatchWorkflow({
      runId: run.id,
      projectSlug: project.slug,
      skipFirebase,
      captureScreenshot,
      screenshotPhones,
    });
    addEvent(run.id, '', 'info', `Dispatched ${config.ci.repo} · ${config.ci.workflow} on ${config.ci.ref}.`);
  } catch (err) {
    log.error('agent dispatch failed', { runId: run.id, error: err.message });
    addEvent(run.id, '', 'error', err.message);
    finishRun(run.id, { status: 'error', summary: 'Could not reach the pipeline repository.' });
    return res.status(502).json({ error: err.message, run: serializeRun(getRun(run.id)) });
  }

  res.status(201).json({ run: serializeRun(getRun(run.id)), firebase: quota });
});

agentRouter.get('/runs/:runId', (req, res) => {
  const run = ownRun(req, res);
  if (!run) return;
  const since = Number(req.query.since || 0);
  res.json({
    run: serializeRun(run),
    events: getEvents(run.id, Number.isFinite(since) ? since : 0)
      .map((e) => ({ id: e.id, level: e.level, stage: e.stage, message: e.message, at: e.created_at })),
    logs: getLogs(run.id).map((l) => ({ id: l.id, stage: l.stage, name: l.name, sizeBytes: l.size })),
    artifacts: getArtifacts(run.id).map((a) => ({
      id: a.id, kind: a.kind, filename: a.filename, sizeBytes: a.size_bytes, sha256: a.sha256,
      name: a.kind === 'screenshot' ? (a.screenshot_name || a.filename.replace(/\.png$/i, '')) : undefined,
      ordinal: a.kind === 'screenshot' ? a.screenshot_ordinal : undefined,
      phone: a.kind === 'screenshot' ? a.screenshot_phone_key : undefined,
      widthPixels: a.kind === 'screenshot' ? a.screenshot_width_pixels : undefined,
      heightPixels: a.kind === 'screenshot' ? a.screenshot_height_pixels : undefined,
    })),
  });
});

agentRouter.get('/runs/:runId/logs/:logId', (req, res) => {
  const run = ownRun(req, res);
  if (!run) return;
  const entry = getLog(req.params.logId);
  if (!entry || entry.run_id !== run.id) return res.status(404).json({ error: 'Log not found.' });

  // Long build logs are the norm; a tail keeps an agent's context usable.
  const tail = Number(req.query.tail || 0);
  const content = tail > 0 ? entry.content.split('\n').slice(-tail).join('\n') : entry.content;
  res.json({ log: { id: entry.id, stage: entry.stage, name: entry.name, content } });
});

agentRouter.get('/runs/:runId/artifacts/:artifactId', (req, res) => {
  const run = ownRun(req, res);
  if (!run) return;
  const artifact = db.prepare('SELECT * FROM artifacts WHERE id = ? AND run_id = ?')
    .get(req.params.artifactId, run.id);
  if (!artifact || !fs.existsSync(artifact.storage_path)) {
    return res.status(404).json({ error: 'Artifact not found.' });
  }
  res.download(artifact.storage_path, artifact.filename);
});

agentRouter.get('/quota', (req, res) => {
  res.json({ firebase: firebaseUsageToday(req.user.id) });
});

export default agentRouter;
