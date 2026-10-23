'use strict';

// Server-side verification ONLY. Never put MSG91_AUTH_KEY in browser JavaScript.
const {createHash} = require('node:crypto');
const VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';

function normalizeIndianMobile(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const cleaned = String(value).trim().replace(/[\s()+-]/g, '');
  if (/^[6-9]\d{9}$/.test(cleaned)) return `91${cleaned}`;
  if (/^91[6-9]\d{9}$/.test(cleaned)) return cleaned;
  return null;
}

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

function createWidgetVerifier({authKey, fetchImpl = globalThis.fetch}) {
  if (!authKey || !String(authKey).trim()) throw new Error('MSG91_AUTH_KEY is required on backend');
  if (typeof fetchImpl !== 'function') throw new Error('Node fetch is required');
  return {
    async verify(accessToken) {
      let response;
      try {
        response = await fetchImpl(VERIFY_URL, {
          method: 'POST',
          headers: {'content-type':'application/json',accept:'application/json'},
          body: JSON.stringify({authkey: String(authKey).trim(), 'access-token': accessToken}),
          signal: AbortSignal.timeout(10000)
        });
      } catch (_) { throw new Error('MSG91_VERIFY_UNAVAILABLE'); }
      let payload;
      try { payload = await response.json(); } catch (_) { throw new Error('MSG91_INVALID_RESPONSE'); }
      // An HTTP 200 is NOT enough. Success response includes verified phone identifier.
      if (!response.ok || payload?.type !== 'success') return null;
      return normalizeIndianMobile(payload.message);
    }
  };
}
module.exports = {createWidgetVerifier, normalizeIndianMobile, sha256};
