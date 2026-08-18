import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import config from './config.js';
import { log } from './log.js';
import { db, seedAdmin, purgeExpiredSessions } from './db.js';
import { sessionMiddleware } from './auth.js';
import { flashMiddleware } from './flash.js';
import { reapStaleRuns } from './runs.js';
import { pagesRouter } from './routes/pages.js';
import { ciRouter } from './routes/ci.js';

const here = path.dirname(fileURLToPath(import.meta.url));

seedAdmin();
purgeExpiredSessions();

const app = express();
app.disable('x-powered-by');
// Asgard terminates TLS upstream; trust it so Secure cookies and IPs work.
app.set('trust proxy', 1);

app.get('/healthz', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  } catch (err) {
    log.error('health check failed', { error: err.message });
    res.status(503).json({ status: 'unavailable' });
  }
});

app.use(express.static(path.join(here, '..', 'public'), {
  maxAge: '1h',
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

// The CI router authenticates by bearer key and must not see browser sessions.
app.use('/api/v1/ci', ciRouter);

app.use(sessionMiddleware);
app.use(flashMiddleware);
app.use(pagesRouter);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found · AppRunner</title><link rel="stylesheet" href="/app.css"></head>
<body><main class="container page"><div class="page-head"><h1>Not found</h1>
<p class="lead">Nothing lives at ${req.path.replace(/[<>&"]/g, '')}.</p></div>
<a class="btn btn-primary" href="/">Back to projects</a></main></body></html>`,
  );
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((err, req, res, _next) => {
  const tooLarge = err?.code === 'LIMIT_FILE_SIZE';
  log.error('request failed', { path: req.path, error: err?.message, stack: tooLarge ? undefined : err?.stack });

  const message = tooLarge
    ? `That file is larger than the ${Math.round(config.maxUploadBytes / 1048576)} MB limit.`
    : 'Something went wrong on the server.';

  if (res.headersSent) return req.destroy();
  if (req.path.startsWith('/api/')) return res.status(tooLarge ? 413 : 500).json({ error: message });

  if (typeof res.flash === 'function') {
    res.flash('error', message);
    return res.redirect(req.get('referer') || '/');
  }
  res.status(500).type('text/plain').send(message);
});

const server = app.listen(config.port, '0.0.0.0', () => {
  log.info('apprunner listening', {
    port: config.port,
    publicUrl: config.publicUrl,
    ciRepo: config.ci.repo || '(unset)',
  });
});

const maintenance = setInterval(() => {
  try {
    purgeExpiredSessions();
    const reaped = reapStaleRuns();
    if (reaped) log.warn('reaped stale runs', { count: reaped });
  } catch (err) {
    log.error('maintenance sweep failed', { error: err.message });
  }
}, 5 * 60 * 1000);
maintenance.unref();

// ── Graceful shutdown ───────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });

  clearInterval(maintenance);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    log.info('shutdown complete');
    process.exit(0);
  });

  // Docker's default grace period is 10s; leave room to flush before it kills us.
  setTimeout(() => {
    log.warn('forcing exit after grace period');
    process.exit(0);
  }, 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { error: String(reason) }));
