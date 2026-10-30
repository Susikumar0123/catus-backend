'use strict';

// Additive, opt-in Cerood Contacts API for the existing PostgreSQL db wrapper.
// This module does not create tables, alter authentication, or run automatically.
const MAX_CONTACTS = 5000;

function clean(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max + 1) : '';
}
function validateContacts(contacts) {
  if (!Array.isArray(contacts) || contacts.length < 1 || contacts.length > MAX_CONTACTS) {
    return { error: `contacts must contain 1-${MAX_CONTACTS} records` };
  }
  const normalized = [];
  for (const [i, item] of contacts.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `contacts[${i}] must be an object` };
    }
    const name = clean(item.name, 255);
    const tel = clean(item.tel, 50);
    const email = clean(item.email ?? '', 255);
    if (!name || name.length > 255 || !tel || tel.length > 50 ||
        !/^\+?[\d\s().-]{5,50}$/.test(tel) || tel.replace(/\D/g, '').length < 5 ||
        email.length > 255 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return { error: `contacts[${i}] has invalid name, phone or email` };
    }
    normalized.push({ name, tel, email });
  }
  return { contacts: normalized };
}
function query(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
  });
}
function register(app, db, middleware) {
  if (!middleware || typeof middleware.requireHomeAuth !== 'function' ||
      typeof middleware.requireAdminAuth !== 'function') {
    throw new Error('Contacts API requires the existing home customer and admin auth middleware');
  }

  app.post('/api/save-contacts', middleware.requireHomeAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (req.body?.consent_confirmed !== true) {
        return res.status(400).json({ success: false, error: 'Confirm contact sharing before uploading' });
      }
      const userId = String(req.homeServiceCustomer?.id || '');
      if (!userId) return res.status(401).json({ success: false, error: 'Login required' });
      if (req.body?.user_id && req.body.user_id !== userId) {
        return res.status(403).json({ success: false, error: 'User ID mismatch' });
      }
      const parsed = validateContacts(req.body?.contacts);
      if (parsed.error) return res.status(400).json({ success: false, error: parsed.error });
      // One PostgreSQL statement for the full consented batch; on repeat sync,
      // existing phone records are skipped instead of storing duplicates.
      const rows = await query(db, `
        INSERT INTO public.user_contacts (user_id, contact_name, phone_number, email)
        SELECT $1::varchar(100), c.name, c.tel, NULLIF(c.email, '')
          FROM jsonb_to_recordset($2::jsonb) AS c(name text, tel text, email text)
        ON CONFLICT (user_id, phone_number) DO NOTHING
        RETURNING id
      `, [userId, JSON.stringify(parsed.contacts)]);
      return res.status(201).json({
        success: true,
        accepted_count: parsed.contacts.length,
        inserted_count: rows.length
      });
    } catch (error) {
      console.error('[contacts-save-error]', error?.code || 'UNKNOWN');
      return res.status(503).json({ success: false, error: 'Unable to save contacts' });
    }
  });

  // A signed-in customer may delete their own shared data at any time.
  app.delete('/api/contacts', middleware.requireHomeAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const userId = String(req.homeServiceCustomer?.id || '');
      if (!userId) return res.status(401).json({ success: false, error: 'Login required' });
      const rows = await query(db,
        'DELETE FROM public.user_contacts WHERE user_id = $1 RETURNING id', [userId]);
      return res.json({ success: true, deleted_count: rows.length });
    } catch (error) {
      console.error('[contacts-delete-error]', error?.code || 'UNKNOWN');
      return res.status(503).json({ success: false, error: 'Unable to delete contacts' });
    }
  });

  app.get('/api/admin/contacts', middleware.requireAdminAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = clean(req.query?.user_id || '', 100);
    if (!userId || userId.length > 100) {
      return res.status(400).json({ success: false, error: 'Valid user_id query parameter required' });
    }
    const page = Number.parseInt(String(req.query?.page || '1'), 10);
    const limit = Number.parseInt(String(req.query?.limit || '50'), 10);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ success: false, error: 'Invalid page/limit' });
    }
    try {
      const rows = await query(db, `
        SELECT id, user_id, contact_name, phone_number, email, synced_at
          FROM public.user_contacts
         WHERE user_id = $1
         ORDER BY id DESC
         LIMIT $2 OFFSET $3
      `, [userId, limit, (page - 1) * limit]);
      return res.json({ success: true, contacts: rows, page, limit });
    } catch (error) {
      console.error('[contacts-admin-error]', error?.code || 'UNKNOWN');
      return res.status(503).json({ success: false, error: 'Unable to retrieve contacts' });
    }
  });
}
module.exports = { register, validateContacts };
