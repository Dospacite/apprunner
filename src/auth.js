import config from './config.js';
import { db, newId, nowIso } from './db.js';
import { signValue, unsignValue, verifyPassword, hashToken } from './crypto.js';

const COOKIE = 'apprunner_session';

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=');
      if (idx < 0) return [part.trim(), ''];
      return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
    }),
  );
}

export function createSession(res, userId) {
  const id = newId();
  const expires = new Date(Date.now() + config.sessionTtlMs);
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, nowIso(), expires.toISOString());

  const attrs = [
    `${COOKIE}=${encodeURIComponent(signValue(id))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`,
  ];
  if (config.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function destroySession(req, res) {
  const raw = parseCookies(req)[COOKIE];
  const id = raw ? unsignValue(raw) : null;
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  const attrs = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function authenticate(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return user;
}

/** Attaches req.user when a valid, unexpired session cookie is present. */
export function sessionMiddleware(req, _res, next) {
  const raw = parseCookies(req)[COOKIE];
  const id = raw ? unsignValue(raw) : null;
  if (id) {
    const row = db.prepare(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ? AND sessions.expires_at > ?`,
    ).get(id, nowIso());
    if (row) req.user = row;
  }
  next();
}

export function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in to continue.' });
  const target = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${target}`);
}

/**
 * Bearer-token auth for the CI pipeline. The key grants read access to the
 * owner's archives and write access to their run status, nothing else.
 */
export function requireCiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : (req.headers['x-apprunner-key'] || '').trim();

  if (!token) return res.status(401).json({ error: 'Missing CI key.' });

  const row = db.prepare(
    `SELECT ci_keys.*, users.id AS owner_id FROM ci_keys
     JOIN users ON users.id = ci_keys.user_id
     WHERE ci_keys.key_hash = ? AND ci_keys.revoked_at IS NULL`,
  ).get(hashToken(token));

  if (!row) return res.status(401).json({ error: 'Invalid or revoked CI key.' });

  db.prepare('UPDATE ci_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), row.id);
  req.ciKey = row;
  req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.owner_id);
  next();
}
