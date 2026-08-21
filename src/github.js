import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import config from './config.js';
import { log } from './log.js';
import { db, nowIso, newId } from './db.js';
import { encryptSecret, decryptSecret } from './crypto.js';

const API = 'https://api.github.com';

export class GitHubError extends Error {}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AppRunner',
  };
}

/**
 * Every GitHub call from this host retries, because the route drops requests
 * intermittently — including small API calls, not just large transfers. A
 * single `fetch failed` used to abort whatever operation was in flight.
 */
async function ghFetch(token, url, init = {}, attempts = 4) {
  const target = url.startsWith('http') ? url : `${API}${url}`;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(target, {
        ...init,
        headers: { ...headers(token), ...(init.headers || {}) },
        signal: init.signal ?? AbortSignal.timeout(60000),
      });
      // A 5xx is worth another try; anything else is the server's real answer.
      if (res.status >= 500 && attempt < attempts) {
        lastError = new GitHubError(`GitHub returned ${res.status}.`);
        log.warn('github call failed, retrying', { url, attempt, status: res.status });
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      return checkStatus(res);
    } catch (err) {
      // checkStatus throws inside the try; those are GitHub's actual answer
      // (bad token, missing repo) and repeating the call cannot change them.
      if (err instanceof GitHubError) throw err;
      lastError = err;
      log.warn('github call errored, retrying', { url, attempt, error: err.message });
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  throw new GitHubError(`Could not reach GitHub after ${attempts} attempts: ${lastError?.message}`);
}

function checkStatus(res) {
  if (res.status === 401) throw new GitHubError('GitHub rejected the token. It may be expired or revoked.');
  if (res.status === 403) throw new GitHubError('GitHub denied the request. Check the token has the `repo` scope.');
  if (res.status === 404) throw new GitHubError('Repository not found, or the token cannot see it.');
  return res;
}

export async function verifyToken(token) {
  const res = await ghFetch(token, '/user');
  if (!res.ok) throw new GitHubError(`GitHub returned ${res.status} while identifying the token.`);
  const user = await res.json();
  return { login: user.login, name: user.name, avatarUrl: user.avatar_url };
}

export function getUserToken(userId) {
  const row = db.prepare('SELECT github_token FROM users WHERE id = ?').get(userId);
  return decryptSecret(row?.github_token);
}

export function setUserToken(userId, token, login) {
  db.prepare('UPDATE users SET github_token = ?, github_login = ?, updated_at = ? WHERE id = ?')
    .run(encryptSecret(token), login || '', nowIso(), userId);
}

export function clearUserToken(userId) {
  db.prepare('UPDATE users SET github_token = NULL, github_login = NULL, updated_at = ? WHERE id = ?')
    .run(nowIso(), userId);
}

/** Repos the connected account can push to, newest activity first. */
export async function listRepos(token) {
  const res = await ghFetch(token, '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
  if (!res.ok) throw new GitHubError(`GitHub returned ${res.status} while listing repositories.`);
  const repos = await res.json();
  return repos.map((r) => ({
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
    description: r.description || '',
  }));
}

export async function getRepo(token, fullName) {
  const res = await ghFetch(token, `/repos/${fullName}`);
  if (!res.ok) throw new GitHubError(`GitHub returned ${res.status} for ${fullName}.`);
  return res.json();
}

export async function resolveCommit(token, fullName, ref) {
  const res = await ghFetch(token, `/repos/${fullName}/commits/${encodeURIComponent(ref)}`);
  if (!res.ok) throw new GitHubError(`Could not resolve ref \`${ref}\` on ${fullName}.`);
  const commit = await res.json();
  return { sha: commit.sha, message: (commit.commit?.message || '').split('\n')[0] };
}

/** Streams the repo tarball to a temp file. Caller owns the file afterwards. */
export async function downloadTarball(token, fullName, ref) {
  const url = `${API}/repos/${fullName}/tarball/${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: headers(token), redirect: 'follow' });
  if (!res.ok) throw new GitHubError(`GitHub returned ${res.status} downloading ${fullName}@${ref}.`);

  fs.mkdirSync(config.tmpDir, { recursive: true });
  const tmpPath = path.join(config.tmpDir, `gh-${newId()}.tar.gz`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpPath));
  return tmpPath;
}

/**
 * Fires the public test repo's workflow. GitHub's dispatch endpoint returns no
 * run id, so the workflow reports its own id back on first contact.
 */
/**
 * Dispatch is retried because the network path to GitHub is measurably
 * unreliable from some hosts: a single transient `fetch failed` would
 * otherwise strand a run in `error` with nothing actually wrong.
 */
export async function dispatchWorkflow({
  runId,
  projectSlug,
  skipFirebase,
  captureScreenshot = false,
  screenshotPhones = ['default'],
  attempts = 4,
}) {
  const { repo, workflow, ref, dispatchToken } = config.ci;
  if (!repo) throw new GitHubError('CI_REPO is not configured on the server.');
  if (!dispatchToken) throw new GitHubError('CI_DISPATCH_TOKEN is not configured on the server.');

  const body = JSON.stringify({
    ref,
    inputs: {
      server_url: config.publicUrl,
      run_id: runId,
      project: projectSlug || '',
      skip_firebase: skipFirebase ? 'true' : 'false',
      capture_screenshot: captureScreenshot ? 'true' : 'false',
      screenshot_phones: JSON.stringify(screenshotPhones),
    },
  });

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        headers: { ...headers(dispatchToken), 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30000),
      });

      if (res.status === 204) return true;

      const text = await res.text();
      // 4xx means the request itself is wrong; retrying cannot help.
      if (res.status >= 400 && res.status < 500) {
        throw new GitHubError(`Workflow dispatch failed (${res.status}): ${text.slice(0, 300)}`);
      }
      lastError = new GitHubError(`Workflow dispatch failed (${res.status}): ${text.slice(0, 200)}`);
    } catch (err) {
      if (err instanceof GitHubError) throw err;
      lastError = new GitHubError(`Could not reach GitHub: ${err.message}`);
    }

    if (attempt < attempts) {
      log.warn('dispatch attempt failed, retrying', { attempt, error: lastError.message });
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }

  throw lastError;
}

export function ciRepoUrl() {
  return config.ci.repo ? `https://github.com/${config.ci.repo}` : '';
}

/**
 * Downloads a GitHub Actions artifact to a temp file.
 *
 * The pipeline publishes build output to Actions rather than pushing it here,
 * because the runner-to-host direction of the GitHub route is far slower than
 * this host pulling from GitHub. The API hands back a zip wrapper regardless of
 * what was uploaded, so the caller unwraps it.
 */
export async function downloadWorkflowArtifact({ runId, name }) {
  const { repo, dispatchToken } = config.ci;
  if (!repo) throw new GitHubError('CI_REPO is not configured on the server.');
  if (!dispatchToken) throw new GitHubError('CI_DISPATCH_TOKEN is not configured on the server.');

  const listed = await ghFetch(dispatchToken, `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`);
  if (!listed.ok) throw new GitHubError(`Could not list artifacts for run ${runId} (${listed.status}).`);

  const { artifacts = [] } = await listed.json();
  const match = artifacts.find((a) => a.name === name && !a.expired);
  if (!match) {
    throw new GitHubError(`No artifact named \`${name}\` on GitHub run ${runId}.`);
  }

  fs.mkdirSync(config.tmpDir, { recursive: true });

  // The route to GitHub drops long transfers, so a single attempt is not
  // enough: undici surfaces the interruption as `terminated` or `fetch failed`
  // partway through the body. Each attempt restarts cleanly into a fresh file.
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const zipPath = path.join(config.tmpDir, `gha-${newId()}.zip`);
    try {
      const res = await fetch(match.archive_download_url, {
        headers: headers(dispatchToken),
        redirect: 'follow',
        signal: AbortSignal.timeout(600000),
      });
      if (!res.ok) throw new GitHubError(`Artifact download failed (${res.status}).`);

      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zipPath));

      const written = fs.statSync(zipPath).size;
      if (match.size_in_bytes && written < match.size_in_bytes * 0.99) {
        throw new Error(`truncated: got ${written} of ${match.size_in_bytes} bytes`);
      }

      log.info('artifact downloaded from github', { name, attempt, bytes: written });
      return { zipPath, sizeBytes: written, expired: match.expired };
    } catch (err) {
      await fs.promises.rm(zipPath, { force: true }).catch(() => {});
      lastError = err;
      log.warn('artifact download attempt failed', { name, attempt, error: err.message });
      if (attempt < 4) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }

  throw new GitHubError(`Could not download ${name} after 4 attempts: ${lastError?.message}`);
}
