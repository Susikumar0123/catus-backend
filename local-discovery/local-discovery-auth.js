'use strict';

const {randomBytes, createHmac} = require('node:crypto');
const {createWidgetVerifier, sha256} = require('./msg91-widget-client');
const SESSION_COOKIE = 'cerood_local_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;

function readCookie(req) {
  const pair = String(req.headers?.cookie || '').split(';')
    .map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + '='));
  const token = pair?.slice(SESSION_COOKIE.length + 1);
  return token && /^[a-zA-Z0-9_-]{43}$/.test(token) ? token : null;
}
function cookie(value, secure, expire = false) {
  return `${SESSION_COOKIE}=${value || ''}; Path=/; HttpOnly; SameSite=Lax; ${secure ? 'Secure; ' : ''}Max-Age=${expire ? 0 : SESSION_SECONDS}`;
}
function reject(res, status, error) { return res.status(status).json({error}); }

function createHandlers({db, env = process.env, widgetVerifier = null, logger = console}) {
  if (!db || typeof db.query !== 'function') throw new Error('db.query is required');
  const originPolicy = require('./origin-policy').createOriginPolicy(env,{requirePrimary:true});
  const secret = String(env.LOCAL_DISCOVERY_RATE_SECRET || '');
  if (secret.length < 32) throw new Error('LOCAL_DISCOVERY_RATE_SECRET must be 32+ characters');
  const secure = originPolicy.secure;
  const verifier = widgetVerifier || createWidgetVerifier({authKey: env.MSG91_AUTH_KEY});
  const safe = f => async (req,res) => {
    try { return await f(req,res); }
    catch(err) { logger.error?.('[local-widget-auth]', err.name); return reject(res,500,'Authentication service unavailable'); }
  };
  function allowMutation(req,res) {
    if (req.get('x-cerood-local-client') !== 'web') { reject(res,403,'Invalid client'); return false; }
    const requestOrigin = req.get('origin');
    if (requestOrigin && !originPolicy.allows(requestOrigin)) { reject(res,403,'Origin rejected'); return false; }
    return true;
  }
  async function rateLimit(req, type, limit) {
    // This must use trusted req.ip from the reverse proxy, not user-supplied headers.
    const address = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const key = createHmac('sha256',secret).update(`${type}|${address}`).digest('hex');
    const rows = await db.query(`
      INSERT INTO local_discovery_rate_limits (rate_key,window_started_at,attempt_count)
      VALUES ($1,now(),1)
      ON CONFLICT (rate_key) DO UPDATE SET
        window_started_at = CASE WHEN local_discovery_rate_limits.window_started_at < now() - interval '1 hour'
           THEN now() ELSE local_discovery_rate_limits.window_started_at END,
        attempt_count = CASE WHEN local_discovery_rate_limits.window_started_at < now() - interval '1 hour'
           THEN 1 ELSE local_discovery_rate_limits.attempt_count + 1 END
      WHERE local_discovery_rate_limits.window_started_at < now() - interval '1 hour'
         OR local_discovery_rate_limits.attempt_count < $2
      RETURNING attempt_count`,[key,limit]);
    return rows.rows.length > 0;
  }

  const widgetLogin = safe(async (req,res) => {
    if (!allowMutation(req,res)) return;
    const accessToken = req.body?.accessToken;
    if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 8192 || !/^[A-Za-z0-9._-]+$/.test(accessToken)) {
      return reject(res,400,'Missing or invalid verified token');
    }
    if (!await rateLimit(req,'widget-login',60)) return reject(res,429,'Too many attempts; try later');
    let verifiedMobile;
    try { verifiedMobile = await verifier.verify(accessToken); }
    catch (_) { return reject(res,502,'MSG91 verification temporarily unavailable'); }
    // Use ONLY the phone confirmed by MSG91. Never trust req.body.mobile / role.
    if (!verifiedMobile) return reject(res,401,'OTP verification failed');
    // Consume each verified access token at most once, even if concurrent requests arrive.
    const oneTime = await db.query(`
      INSERT INTO local_discovery_widget_tokens (token_hash,used_at)
      VALUES ($1,now()) ON CONFLICT (token_hash) DO NOTHING
      RETURNING token_hash`,[sha256(accessToken)]);
    if (!oneTime.rows.length) return reject(res,409,'Verification token already used');
    const found = await db.query(`
      INSERT INTO local_discovery_users (mobile_e164)
      VALUES ($1)
      ON CONFLICT (mobile_e164) DO UPDATE SET
        mobile_verified_at = now(), last_login_at = now()
      RETURNING id,mobile_e164,role`,[verifiedMobile]);
    const user = found.rows[0];
    const sessionToken = randomBytes(32).toString('base64url');
    await db.query(`INSERT INTO local_discovery_sessions (token_hash,user_id,expires_at)
      VALUES ($1,$2,now() + interval '7 days')`,[sha256(sessionToken),user.id]);
    res.setHeader('Set-Cookie',cookie(sessionToken,secure));
    return res.json({ok:true,user:{id:user.id,mobile:user.mobile_e164,role:user.role}});
  });

  const me = safe(async(req,res) => {
    const session = readCookie(req);
    if (!session) return reject(res,401,'Not authenticated');
    const found = await db.query(`SELECT u.id,u.mobile_e164,u.role
      FROM local_discovery_sessions s JOIN local_discovery_users u ON s.user_id=u.id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL`,[sha256(session)]);
    if (!found.rows.length) return reject(res,401,'Not authenticated');
    const user=found.rows[0];
    return res.json({authenticated:true,user:{id:user.id,mobile:user.mobile_e164,role:user.role}});
  });

  const logout = safe(async(req,res) => {
    if (!allowMutation(req,res)) return;
    const session=readCookie(req);
    if (session) await db.query(`UPDATE local_discovery_sessions SET revoked_at=now()
      WHERE token_hash=$1 AND revoked_at IS NULL`,[sha256(session)]);
    res.setHeader('Set-Cookie',cookie('',secure,true));
    return res.json({ok:true});
  });
  return {widgetLogin,me,logout};
}

function mountLocalDiscoveryOtp(app, deps, prefix='/api/local/auth') {
  const handlers=createHandlers(deps);
  app.post(`${prefix}/widget-login`,handlers.widgetLogin);
  app.get(`${prefix}/me`,handlers.me);
  app.post(`${prefix}/logout`,handlers.logout);
  return handlers;
}
module.exports={mountLocalDiscoveryOtp,createHandlers};
