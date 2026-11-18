// Signing in through the House (agreed with Ian, November 2026). The House (stott2026/the-house) is
// the one place Stott and May people sign in; this tool trusts it.
//
// 1. Going through the Gallery's door in the House arrives here with ?house_pass=… in the address:
//    a pass signed by the House, saying who you are, made for this tool only, valid for 60 seconds
//    and usable once. The pass is checked with the House's public key (fetched from
//    <HOUSE_URL>/auth/pass-key), then you're signed in here with a cookie for 7 days and the pass is
//    taken out of the address.
// 2. Opening this tool without being signed in sends you to <HOUSE_URL>/pass?for=<this address>,
//    which signs you in to the House if needed and sends you straight back with a pass.
// 3. Backup (switched off): if the House is ever down, set BACKUP_ACCESS_CODE=true on Railway and
//    the old shared access code (ACCESS_CODE) works again.
import crypto from 'node:crypto';

const HOUSE_URL = (process.env.HOUSE_URL || '').trim().replace(/\/+$/, '');
export const houseReady = /^https?:\/\//.test(HOUSE_URL);
export const backupOn = String(process.env.BACKUP_ACCESS_CODE || '').toLowerCase() === 'true' && Boolean(process.env.ACCESS_CODE);

// Signs this tool's own cookie. SESSION_SECRET is optional: without it a new one is made at start-up,
// which only means people are sent through the House again (instantly) after a restart.
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'cvi_session';
const SIGNED_IN_FOR = 7 * 24 * 60 * 60 * 1000;

// ---- The House's public key ----
let houseKey = null;
let keyFetchedAt = 0;
async function getHouseKey(force = false) {
  if (houseKey && !force) return houseKey;
  if (Date.now() - keyFetchedAt < 30 * 1000) return houseKey; // don't ask the House more than twice a minute
  keyFetchedAt = Date.now();
  try {
    const res = await fetch(`${HOUSE_URL}/auth/pass-key`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) houseKey = crypto.createPublicKey(await res.text());
  } catch (err) {
    console.error(`House sign-in: can't fetch the House's key from ${HOUSE_URL}: ${err.message}`);
  }
  return houseKey;
}

// ---- Checking a pass ----
const usedPasses = new Map(); // pass id → when it expires, so each pass works once
setInterval(() => { const now = Date.now(); for (const [id, exp] of usedPasses) if (exp < now) usedPasses.delete(id); }, 60 * 1000).unref();

async function checkPass(pass, myOrigin) {
  const [payload, signature] = String(pass).split('.');
  if (!payload || !signature) return null;
  const valid = async (key) => key && crypto.verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url'));
  // If it doesn't check out, the House may have a new key (its SESSION_SECRET changed): fetch it once more.
  if (!(await valid(await getHouseKey())) && !(await valid(await getHouseKey(true)))) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (data.v !== 1 || data.aud !== myOrigin || !data.sub || !data.exp || data.exp < now || data.iat > now + 30) return null;
  if (usedPasses.has(data.jti)) return null;
  usedPasses.set(data.jti, data.exp * 1000 + 60 * 1000);
  return { email: String(data.sub), name: String(data.name || '') };
}

// ---- This tool's own cookie ----
function sign(value) { return crypto.createHmac('sha256', SECRET).update(value).digest('base64url'); }

function readSession(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [payload, sig] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Date.now() - data.at < SIGNED_IN_FOR ? data : null;
  } catch { return null; }
}

function writeSession(req, res, user) {
  const payload = Buffer.from(JSON.stringify({ ...user, at: Date.now() })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SIGNED_IN_FOR, path: '/',
  });
}

export function signOut(req, res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
}

const origin = (req) => `${req.protocol}://${req.get('host')}`;

// Where to go to sign in: the House, which sends you back here with a pass.
export function houseSignInUrl(req, path = req.originalUrl) {
  return houseReady ? `${HOUSE_URL}/pass?for=${encodeURIComponent(origin(req) + path)}` : null;
}

// Middleware: a pass in the address signs you in, then the address is tidied.
export async function acceptPass(req, res, next) {
  if (req.method !== 'GET' || !req.query.house_pass || !houseReady) return next();
  const clean = new URL(req.originalUrl, origin(req));
  clean.searchParams.delete('house_pass');
  const user = await checkPass(req.query.house_pass, origin(req));
  if (user) {
    writeSession(req, res, user);
    console.log(JSON.stringify({ event: 'house_sign_in', domain: user.email.split('@')[1] }));
  }
  // A pass that doesn't check out (too old, used already) is just dropped: the page then sends you
  // through the House again for a fresh one.
  res.redirect(clean.pathname + clean.search);
}

// Who is signed in, or null.
export function currentUser(req) {
  return readSession(req);
}
