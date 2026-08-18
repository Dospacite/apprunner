import fs from 'node:fs';
import express from 'express';
import multer from 'multer';
import config from '../config.js';
import { db, newId, nowIso } from '../db.js';
import { authenticate, createSession, destroySession, requireUser } from '../auth.js';
import { generateCiKey, hashToken } from '../crypto.js';
import {
  createProject, updateProject, getProject, listProjects, deleteProject, ValidationError,
} from '../projects.js';
import {
  storeArchive, latestArchive, ArchiveError, deleteArchiveFile,
} from '../archives.js';
import {
  createRun, getRunByNumber, getStages, getEvents, getLogs, getLog,
  getArtifacts, listRuns, activeRun, firebaseUsageToday, isTerminal, finishRun, addEvent,
} from '../runs.js';
import * as github from '../github.js';
import { loginPage } from '../views/login.js';
import { projectsPage, projectFormPage } from '../views/projects.js';
import { projectPage } from '../views/project.js';
import { runPage } from '../views/run.js';
import { settingsPage } from '../views/settings.js';
import { pipelineRail } from '../views/rail.js';
import { log } from '../log.js';

const upload = multer({ dest: config.tmpDir, limits: { fileSize: config.maxUploadBytes } });

export const pagesRouter = express.Router();
pagesRouter.use(express.urlencoded({ extended: false, limit: '256kb' }));

const send = (res, doc) => res.type('html').send(doc);

/** Loads a project the signed-in user owns, or renders a 404. */
function ownProject(req, res) {
  const project = getProject(req.params.id);
  if (!project || project.user_id !== req.user.id) {
    res.status(404).type('html').send(notFoundPage());
    return null;
  }
  return project;
}

function notFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found · AppRunner</title><link rel="stylesheet" href="/app.css"></head>
<body><main class="container page"><div class="page-head"><h1>Not found</h1>
<p class="lead">That project does not exist, or it is not yours.</p></div>
<a class="btn btn-primary" href="/">Back to projects</a></main></body></html>`;
}

function githubState(user) {
  const token = github.getUserToken(user.id);
  return { token, connected: Boolean(token), login: user.github_login || '' };
}

// ── Session ─────────────────────────────────────────────────────────────────

pagesRouter.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  send(res, loginPage({ flash: req.flash, next: String(req.query.next || '') }));
});

pagesRouter.post('/login', (req, res) => {
  const { username = '', password = '', next: nextUrl = '' } = req.body;
  const user = authenticate(String(username).trim(), String(password));

  if (!user) {
    log.warn('login rejected', { username: String(username).slice(0, 40) });
    return send(res, loginPage({
      flash: { kind: 'error', message: 'That username and password do not match.' },
      next: String(nextUrl),
      username: String(username).trim(),
    }));
  }

  createSession(res, user.id);
  const target = String(nextUrl).startsWith('/') ? String(nextUrl) : '/';
  res.redirect(target);
});

pagesRouter.post('/logout', (req, res) => {
  destroySession(req, res);
  res.redirect('/login');
});

// Everything past this point requires a session.
pagesRouter.use(requireUser);

// ── Projects ────────────────────────────────────────────────────────────────

pagesRouter.get('/', (req, res) => {
  send(res, projectsPage({
    user: req.user,
    projects: listProjects(req.user.id),
    flash: req.flash,
    githubConnected: githubState(req.user).connected,
  }));
});

pagesRouter.get('/projects/new', async (req, res) => {
  const { connected, token } = githubState(req.user);
  let repos = [];
  if (connected) {
    try { repos = await github.listRepos(token); } catch { repos = []; }
  }
  send(res, projectFormPage({ user: req.user, flash: req.flash, repos, githubConnected: connected }));
});

pagesRouter.post('/projects/new', (req, res) => {
  try {
    const project = createProject(req.user.id, {
      name: req.body.name,
      description: req.body.description,
      githubRepo: req.body.github_repo,
      githubRef: req.body.github_ref,
    });
    res.flash('success', `Created ${project.name}.`);
    res.redirect(`/projects/${project.id}`);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    res.flash('error', err.message);
    res.redirect('/projects/new');
  }
});

pagesRouter.get('/projects/:id', (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;

  const running = activeRun(project.id);
  const keyCount = db.prepare('SELECT COUNT(*) AS n FROM ci_keys WHERE user_id = ? AND revoked_at IS NULL').get(req.user.id).n;

  send(res, projectPage({
    user: req.user,
    project,
    archives: db.prepare('SELECT * FROM archives WHERE project_id = ? ORDER BY version DESC').all(project.id),
    latest: latestArchive(project.id),
    runs: listRuns(project.id),
    activeRun: running,
    activeStages: running ? getStages(running.id) : [],
    flash: req.flash,
    githubConnected: githubState(req.user).connected,
    firebase: firebaseUsageToday(req.user.id),
    ciKeyCount: keyCount,
    ciRepo: github.ciRepoUrl(),
  }));
});

pagesRouter.get('/projects/:id/settings', async (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;

  const { connected, token } = githubState(req.user);
  let repos = [];
  if (connected) {
    try { repos = await github.listRepos(token); } catch { repos = []; }
  }
  send(res, projectFormPage({ user: req.user, project, flash: req.flash, repos, githubConnected: connected }));
});

pagesRouter.post('/projects/:id/settings', (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;
  try {
    updateProject(project.id, {
      name: req.body.name,
      description: req.body.description,
      githubRepo: req.body.github_repo,
      githubRef: req.body.github_ref,
    });
    res.flash('success', 'Saved.');
    res.redirect(`/projects/${project.id}`);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    res.flash('error', err.message);
    res.redirect(`/projects/${project.id}/settings`);
  }
});

pagesRouter.post('/projects/:id/delete', (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;

  for (const archive of db.prepare('SELECT * FROM archives WHERE project_id = ?').all(project.id)) {
    deleteArchiveFile(archive);
  }
  for (const artifact of db.prepare(
    'SELECT artifacts.* FROM artifacts JOIN runs ON runs.id = artifacts.run_id WHERE runs.project_id = ?',
  ).all(project.id)) {
    try { fs.unlinkSync(artifact.storage_path); } catch { /* already gone */ }
  }

  deleteProject(project.id);
  res.flash('success', `Deleted ${project.name}.`);
  res.redirect('/');
});

// ── Archives ────────────────────────────────────────────────────────────────

pagesRouter.post('/projects/:id/archives', upload.single('archive'), async (req, res) => {
  const project = ownProject(req, res);
  if (!project) {
    if (req.file) await fs.promises.unlink(req.file.path).catch(() => {});
    return;
  }
  if (!req.file) {
    res.flash('error', 'Choose an archive to upload.');
    return res.redirect(`/projects/${project.id}`);
  }

  try {
    const stored = await storeArchive({
      projectId: project.id,
      source: 'upload',
      filename: req.file.originalname,
      tmpPath: req.file.path,
      note: 'Uploaded from the browser.',
    });
    const warnings = [];
    if (!stored.hasTests) warnings.push('no test/ directory');
    if (!stored.hasIntegrationTests) warnings.push('no integration_test/ directory');
    res.flash(
      'success',
      `Uploaded v${stored.version}.${warnings.length ? ` Heads up: ${warnings.join(', ')}.` : ''}`,
    );
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    if (!(err instanceof ArchiveError)) throw err;
    res.flash('error', err.message);
  }
  res.redirect(`/projects/${project.id}`);
});

pagesRouter.post('/projects/:id/resync', async (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;

  const { connected, token } = githubState(req.user);
  if (!project.github_repo) {
    res.flash('error', 'Set a GitHub repository on this project first.');
    return res.redirect(`/projects/${project.id}/settings`);
  }
  if (!connected) {
    res.flash('error', 'Connect a GitHub account before resyncing.');
    return res.redirect('/settings');
  }

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
    res.flash('success', `Pulled v${stored.version} from ${project.github_repo}@${commit.sha.slice(0, 7)}.`);
  } catch (err) {
    if (tmpPath) await fs.promises.unlink(tmpPath).catch(() => {});
    if (err instanceof github.GitHubError || err instanceof ArchiveError) {
      res.flash('error', err.message);
    } else {
      log.error('resync failed', { projectId: project.id, error: err.message });
      res.flash('error', 'Resync failed. Check the server log for details.');
    }
  }
  res.redirect(`/projects/${project.id}`);
});

pagesRouter.get('/projects/:id/archives/:archiveId/download', (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;

  const archive = db.prepare('SELECT * FROM archives WHERE id = ? AND project_id = ?')
    .get(req.params.archiveId, project.id);
  if (!archive || !fs.existsSync(archive.storage_path)) return res.status(404).send('Archive not found.');

  const ext = archive.format === 'zip' ? 'zip' : 'tar.gz';
  res.download(archive.storage_path, `${project.slug}-v${archive.version}.${ext}`);
});

// ── Runs ────────────────────────────────────────────────────────────────────

pagesRouter.post('/projects/:id/runs', async (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;

  const latest = latestArchive(project.id);
  if (!latest) {
    res.flash('error', 'Add an archive before running the pipeline.');
    return res.redirect(`/projects/${project.id}`);
  }
  if (activeRun(project.id)) {
    res.flash('error', 'A run is already in flight for this project.');
    return res.redirect(`/projects/${project.id}`);
  }

  const keyCount = db.prepare('SELECT COUNT(*) AS n FROM ci_keys WHERE user_id = ? AND revoked_at IS NULL').get(req.user.id).n;
  if (!keyCount) {
    res.flash('error', 'Create a CI key first — the runner needs it to fetch the archive.');
    return res.redirect('/settings');
  }

  const quota = firebaseUsageToday(req.user.id);
  const skipFirebase = req.body.skip_firebase === '1' || quota.used >= quota.quota;

  const run = createRun({ projectId: project.id, archiveId: latest.id, skipFirebase });
  if (skipFirebase && quota.used >= quota.quota) {
    addEvent(run.id, 'firebase_test', 'warn', `Firebase stage skipped: daily limit reached (${quota.used}/${quota.quota}).`);
  }

  try {
    await github.dispatchWorkflow({ runId: run.id, projectSlug: project.slug, skipFirebase });
    addEvent(run.id, '', 'info', `Dispatched ${config.ci.repo} · ${config.ci.workflow} on ${config.ci.ref}.`);
    res.flash('success', `Run #${run.number} dispatched.`);
  } catch (err) {
    log.error('dispatch failed', { runId: run.id, error: err.message });
    addEvent(run.id, '', 'error', err.message);
    finishRun(run.id, { status: 'error', summary: 'Could not reach the pipeline repository.' });
    res.flash('error', err.message);
  }

  res.redirect(`/projects/${project.id}/runs/${run.number}`);
});

pagesRouter.get('/projects/:id/runs/:number', (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;

  const run = getRunByNumber(project.id, Number(req.params.number));
  if (!run) return res.status(404).type('html').send(notFoundPage());

  const logs = getLogs(run.id);
  const requested = req.query.log ? getLog(String(req.query.log)) : null;
  const activeLog = requested && requested.run_id === run.id
    ? requested
    : (logs.length ? getLog(logs[logs.length - 1].id) : null);

  send(res, runPage({
    user: req.user,
    project,
    run,
    stages: getStages(run.id),
    events: getEvents(run.id),
    logs,
    artifacts: getArtifacts(run.id),
    activeLog,
    flash: req.flash,
  }));
});

pagesRouter.get('/projects/:id/runs/:number/artifacts/:artifactId', (req, res) => {
  const project = ownProject(req, res);
  if (!project) return;

  const run = getRunByNumber(project.id, Number(req.params.number));
  if (!run) return res.status(404).send('Run not found.');

  const artifact = db.prepare('SELECT * FROM artifacts WHERE id = ? AND run_id = ?').get(req.params.artifactId, run.id);
  if (!artifact || !fs.existsSync(artifact.storage_path)) return res.status(404).send('Artifact not found.');

  res.download(artifact.storage_path, artifact.filename);
});

// ── Live polling for the browser ────────────────────────────────────────────

pagesRouter.get('/api/runs/:runId', (req, res) => {
  const run = db.prepare(
    `SELECT runs.* FROM runs JOIN projects ON projects.id = runs.project_id
     WHERE runs.id = ? AND projects.user_id = ?`,
  ).get(req.params.runId, req.user.id);
  if (!run) return res.status(404).json({ error: 'Run not found.' });

  const stages = getStages(run.id);
  const since = Number(req.query.since || 0);

  res.json({
    status: run.status,
    stage: run.stage,
    done: isTerminal(run.status),
    railHtml: pipelineRail(stages).value,
    railHtmlCompact: pipelineRail(stages, { compact: true }).value,
    events: getEvents(run.id, Number.isFinite(since) ? since : 0).map((e) => ({
      id: e.id,
      level: e.level,
      message: e.message,
      time: new Date(e.created_at).toISOString().slice(11, 19),
    })),
  });
});

// ── Settings ────────────────────────────────────────────────────────────────

pagesRouter.get('/settings', async (req, res) => {
  const { connected, token } = githubState(req.user);
  let repoCount = 0;
  if (connected) {
    try { repoCount = (await github.listRepos(token)).length; } catch { repoCount = 0; }
  }

  const newKeyCookie = req.flash && req.flash.kind === 'key' ? req.flash.message : null;

  send(res, settingsPage({
    user: req.user,
    flash: newKeyCookie ? null : req.flash,
    githubLogin: connected ? (req.user.github_login || 'connected') : '',
    repoCount,
    ciKeys: db.prepare('SELECT * FROM ci_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(req.user.id),
    newKey: newKeyCookie,
    ciRepo: github.ciRepoUrl(),
    publicUrl: config.publicUrl,
    firebase: firebaseUsageToday(req.user.id),
  }));
});

pagesRouter.post('/settings/github', async (req, res) => {
  const token = String(req.body.token || '').trim();
  if (!token) {
    res.flash('error', 'Paste a personal access token.');
    return res.redirect('/settings');
  }
  try {
    const identity = await github.verifyToken(token);
    github.setUserToken(req.user.id, token, identity.login);
    res.flash('success', `Connected as ${identity.login}.`);
  } catch (err) {
    res.flash('error', err instanceof github.GitHubError ? err.message : 'Could not reach GitHub.');
  }
  res.redirect('/settings');
});

pagesRouter.post('/settings/github/disconnect', (req, res) => {
  github.clearUserToken(req.user.id);
  res.flash('success', 'Disconnected GitHub.');
  res.redirect('/settings');
});

pagesRouter.post('/settings/keys', (req, res) => {
  const name = String(req.body.name || '').trim() || 'github-actions';
  const kind = req.body.kind === 'agent' ? 'agent' : 'ci';
  const key = generateCiKey();

  db.prepare('INSERT INTO ci_keys (id, user_id, name, prefix, key_hash, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(newId(), req.user.id, name.slice(0, 60), key.slice(0, 12), hashToken(key), kind, nowIso());

  res.flash('key', key);
  res.redirect('/settings');
});

pagesRouter.post('/settings/keys/:keyId/revoke', (req, res) => {
  db.prepare('UPDATE ci_keys SET revoked_at = ? WHERE id = ? AND user_id = ?')
    .run(nowIso(), req.params.keyId, req.user.id);
  res.flash('success', 'Key revoked.');
  res.redirect('/settings');
});

export default pagesRouter;
