import { html, raw, formatAgo } from './html.js';
import { layout, notice } from './layout.js';

export function settingsPage({ user, flash, githubLogin, repoCount, ciKeys, newKey, ciRepo, publicUrl, firebase }) {
  const body = html`
    <main class="container page">
      ${notice(flash)}

      <div class="page-head">
        <nav class="breadcrumb"><a href="/">projects</a><span>/</span><span>settings</span></nav>
        <h1>Settings</h1>
        <p class="lead" style="max-width: 60ch">
          One GitHub connection for pulling source, and one or more CI keys for handing that source
          to the runner.
        </p>
      </div>

      <div class="split">
        <div class="stack-6">

          <div class="card card-flat">
            <div class="row-between">
              <div class="stack-2">
                <span class="eyebrow">Source</span>
                <h3>GitHub account</h3>
              </div>
              ${githubLogin
                ? html`<span class="badge badge-success"><span class="badge-dot"></span>Connected</span>`
                : html`<span class="badge badge-muted"><span class="badge-dot"></span>Not connected</span>`}
            </div>

            ${githubLogin ? html`
              <p class="body-sm body-muted">
                Connected as <span class="body-mono">${githubLogin}</span>${repoCount ? html` · ${repoCount} repositories visible` : raw('')}.
                Projects with a repository set can pull a fresh archive on demand.
              </p>
              <form method="post" action="/settings/github/disconnect">
                <button class="btn btn-secondary btn-sm" type="submit">Disconnect</button>
              </form>`
            : html`
              <p class="body-sm body-muted">
                Paste a personal access token with the <span class="body-mono">repo</span> scope. It is
                encrypted before it is stored and is never shown again.
              </p>
              <form class="form" method="post" action="/settings/github">
                <div class="field field-mono">
                  <label for="token">Personal access token</label>
                  <input id="token" name="token" type="password" placeholder="ghp_… or github_pat_…" required spellcheck="false" autocomplete="off">
                  <span class="field-help">
                    Create one at <a href="https://github.com/settings/tokens" rel="noreferrer noopener" target="_blank">github.com/settings/tokens</a>.
                  </span>
                </div>
                <div class="form-actions"><button class="btn btn-primary" type="submit">Connect GitHub</button></div>
              </form>`}
          </div>

          <div class="card card-flat">
            <div class="stack-2">
              <span class="eyebrow">Runner</span>
              <h3>CI keys</h3>
            </div>
            <p class="body-sm body-muted">
              The runner sends this key as a bearer token to fetch an archive and report progress.
              Without a project identifier it takes the newest archive across all your projects.
            </p>

            ${newKey ? html`
              <div class="stack-2">
                <p class="body-sm" style="color: var(--accent)">Copy this now — it is not shown again.</p>
                <div class="secret">
                  <code>${newKey}</code>
                  <button class="btn btn-primary btn-sm" type="button" data-copy="${newKey}">Copy</button>
                </div>
              </div>` : raw('')}

            ${ciKeys.length ? html`
              <div class="table-scroll">
                <table class="table">
                  <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr></thead>
                  <tbody>${raw(ciKeys.map((k) => html`
                    <tr>
                      <td class="table-prose">${k.name}</td>
                      <td>${k.prefix}…</td>
                      <td>${formatAgo(k.created_at)}</td>
                      <td>${k.last_used_at ? formatAgo(k.last_used_at) : 'never'}</td>
                      <td style="text-align: right">
                        <form method="post" action="/settings/keys/${k.id}/revoke" onsubmit="return confirm('Revoke ${k.name}? Runs using it will stop working.')">
                          <button class="btn btn-danger btn-sm" type="submit">Revoke</button>
                        </form>
                      </td>
                    </tr>`.value).join(''))}</tbody>
                </table>
              </div>` : html`<p class="body-sm" style="color: var(--meta)">No active keys.</p>`}

            <form class="form" method="post" action="/settings/keys">
              <div class="field">
                <label for="keyname">Key name</label>
                <input id="keyname" name="name" type="text" placeholder="github-actions" required maxlength="60">
                <span class="field-help">Name it after where it will live, so revoking it later is obvious.</span>
              </div>
              <div class="form-actions"><button class="btn btn-accent" type="submit">Create key</button></div>
            </form>
          </div>
        </div>

        <div class="stack-6">
          <div class="card">
            <h3>Wiring the runner</h3>
            <p class="body-sm body-muted">
              Set these on the pipeline repository${ciRepo ? html` (<a href="${ciRepo}" rel="noreferrer noopener" target="_blank">${ciRepo.replace('https://github.com/', '')}</a>)` : raw('')}
              under Settings → Secrets and variables → Actions.
            </p>
            <dl class="deflist">
              <div class="defrow"><dt>APPRUNNER_URL</dt><dd>${publicUrl}</dd></div>
              <div class="defrow"><dt>APPRUNNER_KEY</dt><dd>the key above</dd></div>
              <div class="defrow"><dt>ASC_KEY_ID</dt><dd>App Store Connect key id</dd></div>
              <div class="defrow"><dt>ASC_ISSUER_ID</dt><dd>App Store Connect issuer</dd></div>
              <div class="defrow"><dt>ASC_KEY_P8</dt><dd>base64 .p8</dd></div>
              <div class="defrow"><dt>ASC_TEAM_ID</dt><dd>Apple team id</dd></div>
              <div class="defrow"><dt>FIREBASE_SA</dt><dd>base64 service account</dd></div>
            </dl>
          </div>

          <div class="card">
            <h3>Firebase Test Lab</h3>
            <p class="body-sm body-muted">
              The free tier allows ${firebase.quota} physical-device tests per day. AppRunner counts
              stages that actually started, so a run stopped at an earlier gate costs nothing.
            </p>
            <dl class="deflist">
              <div class="defrow"><dt>Used (24h)</dt><dd>${firebase.used} / ${firebase.quota}</dd></div>
            </dl>
          </div>

          <div class="card">
            <h3>Password</h3>
            <p class="body-sm body-muted">
              The operator password comes from <span class="body-mono">ADMIN_PASSWORD</span> in the
              Asgard deployment and is re-applied on every boot. Change it there.
            </p>
          </div>
        </div>
      </div>
    </main>`;

  return layout({ title: 'Settings', user, body, head: '<script src="/app.js" defer></script>' });
}
