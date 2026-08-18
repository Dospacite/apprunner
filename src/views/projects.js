import { html, raw, formatAgo } from './html.js';
import { layout, notice, statusBadge } from './layout.js';

function projectCard(project) {
  const version = project.latest_version
    ? html`<span class="pill">v${project.latest_version}</span>`
    : html`<span class="pill">no archive</span>`;

  return html`
    <a class="card" href="/projects/${project.id}" style="text-decoration: none; color: inherit">
      <div class="row-between">
        <h3 style="min-width: 0; overflow-wrap: anywhere">${project.name}</h3>
        ${statusBadge(project.last_status)}
      </div>
      ${project.description
        ? html`<p class="body-sm body-muted" style="overflow-wrap: anywhere">${project.description}</p>`
        : html`<p class="body-sm" style="color: var(--meta)">No description.</p>`}
      <div class="row-wrap" style="margin-top: auto; padding-top: var(--space-2)">
        ${version}
        ${project.github_repo ? html`<span class="pill">${project.github_repo}</span>` : raw('')}
      </div>
      <div class="body-mono" style="color: var(--meta); font-size: var(--text-xs)">
        ${project.last_run_number ? html`run #${project.last_run_number} · ${formatAgo(project.last_run_at)}` : html`updated ${formatAgo(project.updated_at)}`}
      </div>
    </a>`;
}

export function projectsPage({ user, projects, flash, githubConnected }) {
  const grid = projects.length
    ? html`<div class="project-grid">${raw(projects.map((p) => projectCard(p).value).join(''))}</div>`
    : html`
      <div class="empty">
        <p>No projects yet. Create one, then upload an archive or point it at a GitHub repository.</p>
        <a class="btn btn-accent" href="/projects/new">Create a project</a>
      </div>`;

  const body = html`
    <main class="container page">
      ${notice(flash)}
      <div class="page-head">
        <div class="row-between">
          <div class="stack-2">
            <span class="eyebrow">Projects</span>
            <h1>Your apps</h1>
          </div>
          ${projects.length ? html`<a class="btn btn-accent" href="/projects/new">New project</a>` : raw('')}
        </div>
        <p class="lead" style="max-width: 62ch">
          Each project keeps a versioned stack of archives. The runner always takes the newest one
          unless a run names a specific version.
        </p>
      </div>

      ${!githubConnected ? html`
        <div class="notice notice-info">
          <span>
            GitHub is not connected. Connect an account in
            <a href="/settings">Settings</a> to resync projects straight from a repository.
          </span>
        </div>` : raw('')}

      ${grid}
    </main>`;

  return layout({ title: 'Projects', user, body });
}

export function projectFormPage({ user, project = null, flash, repos = [], githubConnected }) {
  const editing = Boolean(project);
  const values = project || { name: '', description: '', github_repo: '', github_ref: '' };

  const repoField = githubConnected && repos.length
    ? html`
      <div class="field">
        <label for="github_repo">GitHub repository <span style="color: var(--meta)">(optional)</span></label>
        <select id="github_repo" name="github_repo">
          <option value="">Not connected to a repository</option>
          ${raw(repos.map((r) => `<option value="${r.fullName}"${r.fullName === values.github_repo ? ' selected' : ''}>${r.fullName}${r.private ? ' · private' : ''}</option>`).join(''))}
        </select>
        <span class="field-help">Resyncing pulls a fresh archive from this repository.</span>
      </div>`
    : html`
      <div class="field field-mono">
        <label for="github_repo">GitHub repository <span style="color: var(--meta)">(optional)</span></label>
        <input id="github_repo" name="github_repo" type="text" placeholder="owner/repo"
               value="${values.github_repo}" spellcheck="false">
        <span class="field-help">
          ${githubConnected
            ? 'Enter `owner/repo`.'
            : 'Enter `owner/repo`. Connect GitHub in Settings to resync automatically.'}
        </span>
      </div>`;

  const body = html`
    <main class="container page">
      <div class="page-head">
        <nav class="breadcrumb">
          <a href="/">projects</a><span>/</span>
          ${editing ? html`<a href="/projects/${project.id}">${project.slug}</a><span>/</span><span>settings</span>`
                    : html`<span>new</span>`}
        </nav>
        <h1>${editing ? 'Project settings' : 'New project'}</h1>
        <p class="lead" style="max-width: 58ch">
          ${editing ? 'Every field here can change at any time; archives and runs are unaffected.'
                    : 'Only the name is required. You can add the rest later.'}
        </p>
      </div>

      ${notice(flash)}

      <div class="split">
        <div class="card card-featured">
          <form class="form" method="post" action="${editing ? `/projects/${project.id}/settings` : '/projects/new'}">
            <div class="field">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" value="${values.name}" required autofocus maxlength="80">
            </div>
            <div class="field">
              <label for="description">Description <span style="color: var(--meta)">(optional)</span></label>
              <textarea id="description" name="description" rows="3"
                        placeholder="What this app does.">${values.description}</textarea>
            </div>
            ${repoField}
            <div class="field field-mono">
              <label for="github_ref">Branch or tag <span style="color: var(--meta)">(optional)</span></label>
              <input id="github_ref" name="github_ref" type="text" placeholder="default branch"
                     value="${values.github_ref}" spellcheck="false">
              <span class="field-help">Leave empty to follow the repository's default branch.</span>
            </div>
            <div class="form-actions">
              <button class="btn btn-accent" type="submit">${editing ? 'Save changes' : 'Create project'}</button>
              <a class="btn btn-secondary" href="${editing ? `/projects/${project.id}` : '/'}">Cancel</a>
            </div>
          </form>
        </div>

        ${editing ? html`
          <div class="card">
            <h3>Delete project</h3>
            <p class="body-sm body-muted">
              Removes the project with every archive, run, and log it holds. This cannot be undone.
            </p>
            <form method="post" action="/projects/${project.id}/delete"
                  onsubmit="return confirm('Delete ${project.name} and all of its archives and runs?')">
              <button class="btn btn-danger btn-sm" type="submit">Delete ${project.name}</button>
            </form>
          </div>` : raw('')}
      </div>
    </main>`;

  return layout({ title: editing ? `${project.name} settings` : 'New project', user, body });
}
