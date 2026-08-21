import { html, raw, formatAgo, formatBytes, formatDuration } from './html.js';
import { layout, notice, statusBadge } from './layout.js';
import { pipelineRail } from './rail.js';

function eventRow(event) {
  const time = new Date(event.created_at).toISOString().slice(11, 19);
  return html`<div class="event event-${event.level}"><span class="event-time">${time}</span><span class="event-msg">${event.message}</span></div>`;
}

export function runPage({ user, project, run, stages, events, logs, artifacts, screenshots, activeLog, flash }) {
  const live = run.status === 'queued' || run.status === 'running'
    || ['pending', 'ingesting'].includes(screenshots.status);

  const logTabs = logs.length
    ? html`<div class="row-wrap">${raw(logs.map((l) => {
        const active = activeLog && l.id === activeLog.id;
        return `<a class="pill${active ? ' pill-active' : ''}" href="/projects/${project.id}/runs/${run.number}?log=${l.id}">${l.stage ? `${l.stage} · ` : ''}${l.name}</a>`;
      }).join(''))}</div>`
    : raw('');

  const body = html`
    <main class="container page" ${live ? html`data-run-live="${run.id}"` : raw('')}>
      ${notice(flash)}

      <div class="page-head">
        <nav class="breadcrumb">
          <a href="/">projects</a><span>/</span>
          <a href="/projects/${project.id}">${project.slug}</a><span>/</span>
          <span>run ${run.number}</span>
        </nav>
        <div class="run-head">
          <div class="stack-3">
            <span class="run-number">#${run.number}</span>
            <div class="row-wrap">
              ${statusBadge(run.status)}
              <span class="body-mono" style="color: var(--meta); font-size: var(--text-xs)">
                started ${formatAgo(run.created_at)} · ${run.started_at ? formatDuration(run.started_at, run.finished_at) : 'not started'}
              </span>
            </div>
            ${run.summary ? html`<p class="lead" style="max-width: 60ch">${run.summary}</p>` : raw('')}
          </div>
          <div class="row-wrap">
            ${run.gh_run_url ? html`<a class="btn btn-secondary btn-sm" href="${run.gh_run_url}" rel="noreferrer noopener" target="_blank">Runner log on GitHub</a>` : raw('')}
            <a class="btn btn-primary btn-sm" href="/projects/${project.id}">Back to project</a>
          </div>
        </div>
      </div>

      <div class="split">
        <div class="stack-6">
          <div class="card card-flat">
            <h3>Build log</h3>
            ${logTabs}
            ${activeLog
              ? html`<pre class="logbox" tabindex="0">${activeLog.content}</pre>`
              : html`<p class="body-sm" style="color: var(--meta)">${live ? 'Logs arrive as each stage finishes.' : 'No logs were uploaded for this run.'}</p>`}
          </div>

          <div class="card card-flat">
            <h3>Downloads</h3>
            ${screenshots.phones.some((phone) => phone.images.length) ? html`
              <div class="stack-6">
                ${raw(screenshots.phones.map((phone) => phone.images.length ? html`
                  <section class="stack-3" aria-labelledby="phone-${phone.key}">
                    <div class="stack-2">
                      <h4 id="phone-${phone.key}">${phone.key}</h4>
                      <p class="body-sm body-muted">
                        ${phone.resolved ? `${phone.resolved.model}, ${phone.resolved.runtime}` : 'Device details unavailable'}
                      </p>
                    </div>
                    <div class="screenshot-grid">
                      ${raw(phone.images.map((image) => html`
                        <a class="screenshot-card" href="/projects/${project.id}/runs/${run.number}/artifacts/${image.artifactId}">
                          <img
                            src="/projects/${project.id}/runs/${run.number}/artifacts/${image.artifactId}?inline=1"
                            alt="${image.name} on ${phone.key}"
                          >
                          <span class="body-sm">${image.name}</span>
                          <span class="body-mono body-meta">${image.widthPixels} × ${image.heightPixels} px</span>
                        </a>`.value).join(''))}
                    </div>
                  </section>`.value : '').join(''))}
              </div>` : screenshots.status === 'failed' ? html`
                <p class="body-sm body-warn">Screenshot capture failed: ${screenshots.error}</p>` : raw('')}
            ${artifacts.length ? html`
              <div class="table-scroll">
                <table class="table">
                  <thead><tr><th>Artifact</th><th>Kind</th><th>Size</th><th></th></tr></thead>
                  <tbody>${raw(artifacts.map((a) => html`
                    <tr>
                      <td style="overflow-wrap: anywhere">${a.filename}</td>
                      <td>${a.kind}</td>
                      <td>${formatBytes(a.size_bytes)}</td>
                      <td style="text-align: right"><a class="btn btn-accent btn-sm" href="/projects/${project.id}/runs/${run.number}/artifacts/${a.id}">Download</a></td>
                    </tr>`.value).join(''))}</tbody>
                </table>
              </div>`
              : html`<p class="body-sm" style="color: var(--meta)">
                  ${live ? 'The built application appears here once the iOS build stage passes.' : 'No build output was produced.'}
                </p>`}
          </div>
        </div>

        <div class="stack-6">
          <div class="card card-featured" data-rail-host>
            <div class="row-between">
              <span class="eyebrow">Pipeline</span>
              ${live ? html`<span class="badge badge-accent"><span class="badge-dot"></span>Live</span>` : raw('')}
            </div>
            ${pipelineRail(stages)}
          </div>

          <div class="card">
            <h3>Progress</h3>
            <div class="events" data-events data-last="${events.length ? events[events.length - 1].id : 0}">${raw(events.map((e) => eventRow(e).value).join('')) || raw('<div class="event"><span class="event-time"></span><span class="event-msg">No progress reported yet.</span></div>')}</div>
          </div>
        </div>
      </div>
    </main>`;

  return layout({
    title: `Run #${run.number} · ${project.name}`,
    user,
    body,
    head: '<script src="/app.js" defer></script>',
  });
}
