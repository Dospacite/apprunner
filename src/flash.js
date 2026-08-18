import config from './config.js';

const COOKIE = 'apprunner_flash';

/** One-shot messages survive a redirect in a cookie and are cleared on read. */
export function flashMiddleware(req, res, next) {
  const header = req.headers.cookie || '';
  const match = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE}=`));

  req.flash = null;
  if (match) {
    try {
      req.flash = JSON.parse(Buffer.from(decodeURIComponent(match.slice(COOKIE.length + 1)), 'base64').toString('utf8'));
    } catch { /* malformed cookie, ignore */ }
    const cleared = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (config.cookieSecure) cleared.push('Secure');
    appendCookie(res, cleared.join('; '));
  }

  res.flash = (kind, message) => {
    const value = Buffer.from(JSON.stringify({ kind, message: String(message).slice(0, 400) })).toString('base64');
    const attrs = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=30'];
    if (config.cookieSecure) attrs.push('Secure');
    appendCookie(res, attrs.join('; '));
  };

  next();
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) return res.setHeader('Set-Cookie', cookie);
  res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
}
