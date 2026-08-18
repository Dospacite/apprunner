import { html, raw, esc } from './html.js';

export function layout({ title, user, body, activeProject = null, bare = false, head = '' }) {
  const nav = bare || !user ? raw('') : html`
    <header class="topbar">
      <div class="container topbar-inner">
        <a class="wordmark" href="/">App<span class="wordmark-run">Runner</span></a>
        <div class="topbar-meta">
          <a class="body-sm" href="/settings" style="color: var(--muted)">Settings</a>
          <span class="body-mono body-muted">${user.username}</span>
          <form method="post" action="/logout">
            <button class="btn btn-secondary btn-sm" type="submit">Sign out</button>
          </form>
        </div>
      </div>
    </header>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · AppRunner</title>
<meta name="color-scheme" content="light">
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#26251e"/><path d="M12 9l8 7-8 7" fill="none" stroke="#f54e00" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  )}">
${head}
</head>
<body${activeProject ? ` data-project="${esc(activeProject)}"` : ''}>
${esc(nav)}
${esc(body)}
</body>
</html>`;
}

export function notice(flash) {
  if (!flash || !flash.message) return raw('');
  const kind = ['error', 'success', 'info'].includes(flash.kind) ? flash.kind : 'info';
  return html`<div class="notice notice-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${flash.message}</div>`;
}

const STATUS_BADGE = {
  queued:    ['badge-muted', 'Queued'],
  running:   ['badge-accent', 'Running'],
  passed:    ['badge-success', 'Passed'],
  failed:    ['badge-danger', 'Failed'],
  error:     ['badge-danger', 'Errored'],
  cancelled: ['badge-muted', 'Cancelled'],
};

export function statusBadge(status) {
  const [cls, label] = STATUS_BADGE[status] || ['badge-muted', status || 'No runs'];
  return html`<span class="badge ${cls}"><span class="badge-dot"></span>${label}</span>`;
}
