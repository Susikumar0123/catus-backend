'use strict';

// CEROOD HOME SERVICE — CONVERSION METRICS (PHASE 1)
// Deliberately separate from existing checkout, order, payment and technician flows.
// No phone numbers, names, addresses, approval keys or raw URLs stored here.
const ENABLED = () => process.env.CEROOD_CONVERSION_TRACKING_ENABLED === 'true';
const ALLOWED_EVENTS = new Set(['call_click', 'browse_services', 'checkout_view', 'booking_attempt']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_VISIT = /^[a-zA-Z0-9-]{1,64}$/;
const DEFAULT_API_ROUTE = '/api/home-services/conversion-event';
const requests = new Map();

function cleanText(value, max = 120) {
  return String(value ?? '').trim().slice(0, max).replace(/[\u0000-\u001f<>]/g, '');
}
function cleanPath(value) {
  const path = cleanText(value, 240).split('?')[0].split('#')[0];
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('..') ? path : '/';
}
function cleanHost(value) {
  const host = cleanText(value, 120).toLowerCase();
  return /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/.test(host) ? host : '';
}
function attribution(body = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return {
    visit_id: SAFE_VISIT.test(String(b.visit_id || '')) ? String(b.visit_id) : null,
    landing_path: cleanPath(b.landing_path),
    page_path: cleanPath(b.page_path),
    utm_source: cleanText(b.utm_source, 64),
    utm_medium: cleanText(b.utm_medium, 64),
    utm_campaign: cleanText(b.utm_campaign, 100),
    referrer_host: cleanHost(b.referrer_host)
  };
}
function isAllowed(req, limit = 30) {
  // Best-effort aggregation for analytics traffic behind Render's reverse proxy.
  // This is abuse throttling, not an authentication or security boundary.
  const forwarded = typeof req.get === 'function' ? req.get('x-forwarded-for') : '';
  const ip = cleanText(String(forwarded || req.ip || req.socket?.remoteAddress || 'unknown').split(',')[0], 80);
  const now = Date.now();
  const slot = requests.get(ip);
  if (slot && now - slot.start < 60000) {
    slot.count++;
    return slot.count <= limit;
  }
  if (requests.size > 30000) requests.clear();
  requests.set(ip, { start: now, count: 1 });
  return true;
}
function query(db, sql, params = []) {
  return new Promise((resolve, reject) => db.query(sql, params, (error, rows) => {
    if (error) reject(error); else resolve(rows || []);
  }));
}
async function recordBooking(db, booking) {
  if (!ENABLED()) return false;
  const orderId = String(booking?.order_id || '');
  const requestId = String(booking?.booking_request_id || '');
  if (!/^CHS-[0-9a-f-]{36}$/i.test(orderId) || !UUID.test(requestId)) return false;
  const a = attribution(booking?.conversion);
  await query(db, `INSERT INTO public.cerood_hs_conversion_events
    (event_type,visit_id,landing_path,page_path,utm_source,utm_medium,utm_campaign,referrer_host,order_id,booking_request_id)
    VALUES('booking_created',?,?,?,?,?,?,?,?,?::uuid)
    ON CONFLICT DO NOTHING`,
    [a.visit_id,a.landing_path,a.page_path,a.utm_source,a.utm_medium,a.utm_campaign,a.referrer_host,orderId,requestId]);
  return true;
}
function register(app, db, requireAdminAuth) {
  app.post(DEFAULT_API_ROUTE, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!ENABLED()) return res.status(503).json({ success: false, message: 'Conversion tracking is not enabled.' });
    if (!isAllowed(req)) return res.status(429).json({ success: false, message: 'Too many events.' });
    if (!req.is('application/json') || JSON.stringify(req.body || {}).length > 3000) {
      return res.status(400).json({ success: false, message: 'Invalid event payload.' });
    }
    const event = cleanText(req.body?.event_type, 40);
    if (!ALLOWED_EVENTS.has(event)) return res.status(400).json({success:false,message:'Invalid event.'});
    const a = attribution(req.body?.conversion);
    try {
      await query(db, `INSERT INTO public.cerood_hs_conversion_events
        (event_type,visit_id,landing_path,page_path,utm_source,utm_medium,utm_campaign,referrer_host)
        VALUES(?,?,?,?,?,?,?,?)`,
        [event,a.visit_id,a.landing_path,a.page_path,a.utm_source,a.utm_medium,a.utm_campaign,a.referrer_host]);
      return res.status(202).json({ success: true });
    } catch (error) {
      console.error('[cerood-conversion] event storage failed:', error.message);
      return res.status(503).json({ success: false, message: 'Event storage unavailable.' });
    }
  });

  // requireAdminAuth prevents publicly enumerating bookings or marketing metrics.
  app.get('/api/admin/home-services/conversion-summary', requireAdminAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const days = Number(req.query.days || 7);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return res.status(400).json({ success: false, message: 'Days must be between 1 and 90.' });
    }
    try {
      const totals = await query(db, `SELECT event_type,COUNT(*)::integer AS count,
        COUNT(DISTINCT visit_id)::integer AS distinct_visits
        FROM public.cerood_hs_conversion_events
        WHERE created_at >= NOW() - (?::integer * INTERVAL '1 day')
        GROUP BY event_type ORDER BY event_type`, [days]);
      const byDay = await query(db, `SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day,event_type,COUNT(*)::integer AS count
        FROM public.cerood_hs_conversion_events
        WHERE created_at >= NOW() - (?::integer * INTERVAL '1 day')
        GROUP BY day,event_type ORDER BY day,event_type`, [days]);
      const sources = await query(db, `SELECT CASE WHEN NULLIF(utm_source,'') IS NOT NULL THEN utm_source
          WHEN referrer_host ~* '(^|\\.)google\\.' THEN 'google_organic'
          WHEN referrer_host ~* '(^|\\.)bing\\.' THEN 'bing_organic'
          WHEN NULLIF(referrer_host,'') IS NOT NULL THEN referrer_host
          ELSE 'direct_or_unknown' END AS source, event_type,
        COUNT(*)::integer AS count FROM public.cerood_hs_conversion_events
        WHERE created_at >= NOW() - (?::integer * INTERVAL '1 day')
        AND event_type='booking_created' GROUP BY source,event_type ORDER BY count DESC LIMIT 20`, [days]);
      return res.json({ success:true, days, totals, daily: byDay, booking_sources:sources,
        note:'Click events are intent signals, not completed phone calls. Booking_created counts newly recorded free booking requests only, not completed technician jobs.' });
    } catch (error) {
      console.error('[cerood-conversion] summary failed:', error.message);
      return res.status(503).json({ success: false, message: 'Metrics unavailable. Check the SQL migration.' });
    }
  });
  // CEROOD ATTRIBUTION AUDIT V1: backend admin-only, read-only; no front-end changes.
  app.get('/api/admin/home-services/attribution-audit', requireAdminAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const days = Number(req.query?.days || 7);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return res.status(400).json({success: false, message: 'Days must be 1 to 90.'});
    }
    try {
      const buckets = await query(db, `
        WITH bookings AS (
          SELECT created_at, visit_id, order_id, referrer_host, utm_source, utm_medium
          FROM public.cerood_hs_conversion_events
          WHERE event_type = 'booking_created'
            AND created_at >= NOW() - (?::integer * INTERVAL '1 day')
        ), journeys AS (
          SELECT b.*,
            (SELECT COUNT(*) FROM public.cerood_hs_conversion_events e
              WHERE b.visit_id IS NOT NULL AND e.visit_id = b.visit_id
                AND e.created_at <= b.created_at AND e.event_type <> 'booking_created'
            ) AS prior_events,
            (SELECT CASE
               WHEN e.landing_path IS NOT NULL AND e.landing_path NOT IN ('','/checkout','/checkout.html') THEN e.landing_path
               WHEN e.page_path IS NOT NULL AND e.page_path NOT IN ('','/checkout','/checkout.html') THEN e.page_path
               ELSE NULL END
             FROM public.cerood_hs_conversion_events e
             WHERE b.visit_id IS NOT NULL AND e.visit_id = b.visit_id
               AND e.created_at <= b.created_at AND e.event_type <> 'booking_created'
               AND (e.landing_path NOT IN ('','/checkout','/checkout.html')
                 OR e.page_path NOT IN ('','/checkout','/checkout.html'))
             ORDER BY e.created_at ASC LIMIT 1) AS earlier_page
          FROM bookings b
        ), attributed AS (
          SELECT j.*,
            CASE
              WHEN LOWER(COALESCE(referrer_host,'')) LIKE '%.workers.dev' THEN 'preview_or_staging'
              WHEN LOWER(COALESCE(utm_source,'')) IN ('chatgpt.com','chatgpt') THEN 'chatgpt_utm_reported'
              WHEN LOWER(COALESCE(utm_source,'')) IN ('google','google.com','google_organic')
                AND LOWER(COALESCE(utm_medium,'')) IN ('organic','seo') THEN 'google_organic_utm_reported'
              WHEN LOWER(COALESCE(referrer_host,'')) LIKE 'google.%'
                OR LOWER(COALESCE(referrer_host,'')) LIKE '%.google.%' THEN 'google_referrer_channel_unverified'
              WHEN LOWER(COALESCE(referrer_host,'')) IN ('www.cerood.com','cerood.com') THEN 'cerood_self_referral_source_unknown'
              WHEN NULLIF(TRIM(COALESCE(utm_source,'')),'') IS NOT NULL THEN 'other_utm_reported'
              WHEN NULLIF(TRIM(COALESCE(referrer_host,'')),'') IS NOT NULL THEN 'other_referrer_unverified'
              ELSE 'direct_or_unknown'
            END AS source_bucket
          FROM journeys j
        )
        SELECT source_bucket, COUNT(*)::integer AS booking_events,
          COUNT(DISTINCT order_id)::integer AS unique_order_ids,
          SUM(CASE WHEN prior_events > 0 THEN 1 ELSE 0 END)::integer AS with_prior_events,
          SUM(CASE WHEN earlier_page IS NOT NULL THEN 1 ELSE 0 END)::integer AS earlier_page_found
        FROM attributed GROUP BY source_bucket ORDER BY booking_events DESC, source_bucket
      `, [days]);
      return res.json({ success: true, days, buckets,
        note: 'Preview/staging is separate. Cerood self-referrals are NOT Google organic. UTM/referrer sources are unverified. Booking events do not guarantee completed jobs. Earlier pages count only what previous same-visit events actually recorded.' });
    } catch (err) {
      console.error('[cerood-attribution-audit] query failure:', err.message);
      return res.status(503).json({success:false, message:'Attribution analytics unavailable.'});
    }
  });

}
module.exports = { register, recordBooking, __test: { attribution, cleanPath, cleanHost, cleanText, isAllowed } };
