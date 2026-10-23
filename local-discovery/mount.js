'use strict';

// Adapt Cerood's existing db.getClient() query interface to the
// {rows: [...]} format required by Local Discovery's OTP module.
// The rest of the existing Cerood backend remains unchanged.
function createLocalDiscoveryDbAdapter(existingDb) {
  if (!existingDb || typeof existingDb.getClient !== 'function') {
    throw new Error('Existing Cerood backend must expose db.getClient()');
  }
  return {
    async query(sql, params = []) {
      const client = await existingDb.getClient();
      try {
        const result = await client.query(sql, params);
        if (Array.isArray(result)) return {rows: result};
        if (result && Array.isArray(result.rows)) return {rows: result.rows};
        throw new Error('Unexpected result from existing Cerood db client');
      } finally {
        if (typeof client.release === 'function') client.release();
      }
    }
  };
}

function mountLocalDiscoveryOnExistingCeroodBackend(app, existingDb) {
  const {mountLocalDiscoveryOtp} = require('./local-discovery-auth');
  return mountLocalDiscoveryOtp(app, {db: createLocalDiscoveryDbAdapter(existingDb)});
}

module.exports = mountLocalDiscoveryOnExistingCeroodBackend;
module.exports.createLocalDiscoveryDbAdapter = createLocalDiscoveryDbAdapter;
