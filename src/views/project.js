import { html, raw, formatAgo, formatBytes, formatDuration } from './html.js';
import { layout, notice, statusBadge } from './layout.js';
import { pipelineRail } from './rail.js';

function archiveRow(archive, isLatest) {
  return html`
    <tr>
      <td>v${archive.version}${isLatest ? html` <span class="badge badge-accent">latest</span>` : raw('')}</td>
      <td>${archive.source === 'github' ? 'github' : 'upload'}</td>
      <td class="table-prose">${archive.commit_sha ? archive.commit_sha.slice(0, 7) : archive.filename}</td>
      <td>${formatBytes(archive.size_bytes)}</td>
      <td>${formatAgo(archive.created_at)}</td>
      <td style="text-align: right"><a class="btn btn-secondary btn-sm" href="/projects/${archive.project_id}/archives/${archive.id}/download">Download</a></td>
    </tr>`;
}

function runRow(run) {
  return html`
    <tr>
      <td><a href="/projects/${run.project_id}/runs/${run.number}">#${run.number}</a></td>
      <td>${statusBadge(run.status)}</td>
      <td class="table-prose" style="overflow-wrap: anywhere">${run.summary || (run.stage ? `at ${run.stage}` : '—')}</td>
      <td>${run.started_at ? formatDuration(run.started_at, run.finished_at) : '—'}</td>
      <td>${formatAgo(run.created_at)}</td>
    </tr>`;
}

export function projectPage({
  user, project, archives, latest, runs, activeRun, activeStages,
  flash, githubConnected, firebase, ciKeyCount, ciRepo,
}) {
  const canRun = Boolean(latest) && !activeRun;

  const runPanel = activeRun
    ? html`
      <div class="card card-featured" data-run-poll="${activeRun.id}">
        <div class="row-between">
          <div class="stack-2">
            <span class="eyebrow">Run in flight</span>
            <h3>Run #${activeRun.number}</h3>
          </div>
          ${statusBadge(activeRun.status)}
        </div>
        ${pipelineRail(activeStages, { compact: true })}
        <a class="btn btn-primary btn-sm" href="/projects/${project.id}/runs/${activeRun.number}">Open run</a>
      </div>`
    : html`
      <div class="card card-featured">
        <div class="stack-2">
          <span class="eyebrow">Build and test</span>
          <h3>Run the pipeline</h3>
        </div>
        <p class="body-sm body-muted">
          ${latest
            ? html`The runner pulls v${latest.version} with your CI key and walks the three gates in order.`
            : 'Add an archive first — there is nothing for the runner to fetch.'}
        </p>
        ${pipelineRail(
          [
            { key: 'flutter_test', label: 'Flutter tests', status: 'pending', hint: 'Unit and widget tests on the Dart VM.' },
            { key: 'ios_build', label: 'iOS build', status: 'pending', hint: 'Release build plus the XCTest bundle for Test Lab.' },
            { key: 'firebase_test', label: 'Firebase XCTest', status: 'pending', hint: 'XCUITest on a physical device via Firebase Test Lab.' },
          ],
        )}
        <form method="post" action="/projects/${project.id}/runs" class="stack-3">
          <label class="row-wrap body-sm body-muted" style="gap: var(--space-2)">
            <input type="checkbox" name="skip_firebase" value="1" style="width: auto"
                   ${firebase.used >= firebase.quota ? 'checked' : ''}>
            Skip the Firebase stage
          </label>
          <button class="btn btn-accent" type="submit" ${canRun ? '' : 'disabled'}>Build and test</button>
        </form>
        ${firebase.used >= firebase.quota
          ? html`<p class="body-sm body-warn">
              Firebase Test Lab is at its daily limit (${firebase.used}/${firebase.quota}). The stage will report as skipped.
            </p>`
          : html`<p class="body-sm body-meta">
              Firebase Test Lab: ${firebase.used}/${firebase.quota} device tests used in the last 24 hours.
            </p>`}
      </div>`;

  const body = html`
    <main class="container page" data-project-id="${project.id}">
      ${notice(flash)}

      <div class="page-head">
        <nav class="breadcrumb"><a href="/">projects</a><span>/</span><span>${project.slug}</span></nav>
        <div class="row-between">
          <div class="stack-2">
            <h1 style="overflow-wrap: anywhere">${project.name}</h1>
            ${project.description
              ? html`<p class="lead" style="max-width: 60ch">${project.description}</p>`
              : raw('')}
          </div>
          <a class="btn btn-secondary" href="/projects/${project.id}/settings">Settings</a>
        </div>
      </div>

      <div class="split">
        <div class="stack-6">

          <div class="card card-flat">
            <div class="row-between">
              <div class="stack-2">
                <span class="eyebrow">Source</span>
                <h3>Upload an archive</h3>
              </div>
              ${latest ? html`<span class="pill pill-active">v${latest.version} · ${formatAgo(latest.created_at)}</span>` : raw('')}
            </div>
            <form class="form" method="post" action="/projects/${project.id}/archives"
                  enctype="multipart/form-data" data-upload>
              <label class="dropzone" tabindex="0" data-dropzone>
                <input class="visually-hidden" type="file" name="archive" accept=".zip,.tar.gz,.tgz" required data-file>
                <span class="dropzone-name" data-dropzone-name>Choose a .zip or .tar.gz</span>
                <span class="body-sm" style="color: var(--meta)">The archive must hold pubspec.yaml at its root.</span>
              </label>
              <div class="form-actions">
                <button class="btn btn-accent" type="submit">Upload archive</button>
                ${project.github_repo
                  ? html`<button class="btn btn-primary" type="submit" form="resync-form"
                                 ${githubConnected ? '' : 'disabled'}>Resync from GitHub</button>`
                  : raw('')}
              </div>
            </form>
            ${project.github_repo
              ? html`<form id="resync-form" method="post" action="/projects/${project.id}/resync"></form>`
              : raw('')}
            ${project.github_repo && !githubConnected
              ? html`<p class="body-sm body-warn">
                  Connect GitHub in <a href="/settings">Settings</a> before resyncing ${project.github_repo}.
                </p>`
              : raw('')}
          </div>

          <div class="card card-flat">
            <div class="row-between">
              <h3>Archives</h3>
              <span class="body-mono body-meta" style="font-size: var(--text-xs)">${archives.length} version${archives.length === 1 ? '' : 's'}</span>
            </div>
            ${archives.length ? html`
              <div class="table-scroll">
                <table class="table">
                  <thead><tr><th>Version</th><th>Source</th><th>Ref</th><th>Size</th><th>Added</th><th></th></tr></thead>
                  <tbody>${raw(archives.map((a) => archiveRow(a, latest && a.id === latest.id).value).join(''))}</tbody>
                </table>
              </div>` : html`<p class="body-sm body-meta">No archives yet.</p>`}
          </div>

          <div class="card card-flat">
            <div class="row-between">
              <h3>Runs</h3>
              <span class="body-mono body-meta" style="font-size: var(--text-xs)">${runs.length ? `latest #${runs[0].number}` : 'none'}</span>
            </div>
            ${runs.length ? html`
              <div class="table-scroll">
                <table class="table">
                  <thead><tr><th>Run</th><th>Status</th><th>Outcome</th><th>Duration</th><th>Started</th></tr></thead>
                  <tbody>${raw(runs.map((r) => runRow(r).value).join(''))}</tbody>
                </table>
              </div>` : html`<p class="body-sm body-meta">No runs yet.</p>`}
          </div>
        </div>

        <div class="stack-6">
          ${runPanel}

          <div class="card">
            <h3>Details</h3>
            <dl class="deflist">
              <div class="defrow"><dt>Identifier</dt><dd>${project.slug}</dd></div>
              <div class="defrow"><dt>Repository</dt><dd>${project.github_repo || '—'}</dd></div>
              <div class="defrow"><dt>Ref</dt><dd>${project.github_ref || 'default'}</dd></div>
              <div class="defrow"><dt>Created</dt><dd>${project.created_at.slice(0, 10)}</dd></div>
            </dl>
          </div>

          <div class="card">
            <h3>Runner access</h3>
            <p class="body-sm body-muted">
              ${ciKeyCount
                ? html`The runner reads this project with a CI key. Manage keys in <a href="/settings">Settings</a>.`
                : html`No CI key exists yet. Create one in <a href="/settings">Settings</a> before running the pipeline.`}
            </p>
            ${ciRepo ? html`<p class="body-sm body-meta">Pipeline repository: <a href="${ciRepo}">${ciRepo.replace('https://github.com/', '')}</a></p>` : raw('')}
          </div>
        </div>
      </div>
    </main>`;

  return layout({ title: project.name, user, body, head: '<script src="/app.js" defer></script>' });
}
