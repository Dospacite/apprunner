import { html, raw, formatDuration } from './html.js';

const DETAIL_FALLBACK = {
  running: 'In progress.',
  skipped: 'Skipped for this run.',
  blocked: 'Not reached — an earlier stage failed.',
};

// The first stage has no gate above it, so it waits on the runner, not a gate.
const PENDING_DETAIL = (index) => (index === 0 ? 'Not started.' : 'Waiting for the gate above.');

/**
 * Renders the gate sequence. The connector above each stage is coloured by the
 * transition that produced it, so the eye lands on where the run stopped.
 */
export function pipelineRail(stages, { compact = false } = {}) {
  const parts = stages.map((stage, index) => {
    const gate = index === 0 ? '' : gateClass(stages[index - 1], stage);
    const connector = index === 0 ? '' : `<div class="rail-gate ${gate}"></div>`;
    const detail = stage.detail
      || (stage.status === 'pending' ? PENDING_DETAIL(index) : DETAIL_FALLBACK[stage.status])
      || '';
    const duration = stage.started_at ? formatDuration(stage.started_at, stage.finished_at) : '';

    return `${connector}
      <div class="rail-stage rail-${stage.status}">
        <span class="rail-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="rail-dot" aria-hidden="true"></span>
        <span class="rail-body">
          <span class="rail-label">${escapeText(stage.label || stage.key)}</span>
          ${detail ? `<span class="rail-detail">${escapeText(detail)}</span>` : ''}
          ${!compact && stage.hint && stage.status === 'pending' ? `<span class="rail-hint">${escapeText(stage.hint)}</span>` : ''}
        </span>
        <span class="rail-time">${duration}</span>
      </div>`;
  });

  return raw(`<div class="rail" role="list" aria-label="Build pipeline">${parts.join('')}</div>`);
}

function gateClass(previous, current) {
  if (previous.status === 'failed') return 'rail-gate-closed';
  // Nothing is flowing into a stage that will not run, however the gate above
  // it resolved, so the connector stays neutral rather than reading as live.
  if (current.status === 'skipped') return '';
  if (previous.status === 'passed') return 'rail-gate-open';
  if (previous.status === 'running') return 'rail-gate-live';
  return '';
}

function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
