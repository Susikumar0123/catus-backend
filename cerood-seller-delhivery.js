'use strict';

// ============================================================
// CEROOD × DELHIVERY — PER-SELLER PICKUP SERVICEABILITY (PHASE 1)
//
// Purpose:
//   - Every Cerood seller keeps their own pickup/fulfilment location.
//   - Cerood checks Delhivery pickup availability for that exact pincode.
//   - Results are cached on cerood_seller_locations and shown in Seller Dashboard.
//   - API token stays server-side only.
//
// Required private environment variable:
//   DELHIVERY_API_TOKEN
//
// Optional:
//   DELHIVERY_BASE_URL=https://track.delhivery.com
//   DELHIVERY_SERVICEABILITY_TTL_HOURS=24
//
// This phase intentionally does NOT create a shipment or pickup request yet.
// Shipment fallback will be wired after a live Delhivery account/token test.
// ============================================================

const axios = require('axios');

module.exports = function registerCeroodSellerDelhivery(
    app,
    db,
    requireSellerAuth,
    requireAdminAuth
) {
    const DELHIVERY_BASE_URL = String(
        process.env.DELHIVERY_BASE_URL || 'https://track.delhivery.com'
    ).trim().replace(/\/$/, '');

    const TTL_HOURS = Math.max(
        1,
        Math.min(168, Number(process.env.DELHIVERY_SERVICEABILITY_TTL_HOURS || 24) || 24)
    );

    const query = (sql, params = []) => new Promise((resolve, reject) => {
        db.query(sql, params, (error, rows) => {
            if (error) return reject(error);
            resolve(rows || []);
        });
    });

    const clean = (value, max = 500) => String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);

    const digits = value => String(value ?? '').replace(/\D/g, '');
    const pin6 = value => digits(value).slice(0, 6);
    const yes = value => String(value ?? '').trim().toUpperCase() === 'Y';
    const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(String(value || '').trim());

    function httpError(status, message, code) {
        const error = new Error(message);
        error.status = status;
        if (code) error.code = code;
        return error;
    }

    let schemaPromise;
    function ensureSchema() {
        if (!schemaPromise) {
            schemaPromise = (async () => {
                const statements = [
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_pickup_serviceable BOOLEAN`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_delivery_serviceable BOOLEAN`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_prepaid_serviceable BOOLEAN`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_cod_serviceable BOOLEAN`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_serviceability_checked_at TIMESTAMPTZ`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_serviceability_error TEXT`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_serviceability_response JSONB`
                ];
                for (const sql of statements) await query(sql);
            })().catch(error => {
                schemaPromise = null;
                throw error;
            });
        }
        return schemaPromise;
    }

    function delhiveryConfig() {
        const token = String(process.env.DELHIVERY_API_TOKEN || '').trim();
        if (!token) {
            throw httpError(
                503,
                'Delhivery API token is not configured on the server.',
                'DELHIVERY_CONFIG'
            );
        }
        return { token };
    }

    async function delhiveryRequest(config) {
        const { token } = delhiveryConfig();
        try {
            return await axios.request({
                ...config,
                url: `${DELHIVERY_BASE_URL}${config.url}`,
                headers: {
                    Accept: 'application/json',
                    ...(config.headers || {}),
                    Authorization: `Token ${token}`
                },
                timeout: config.timeout || 20_000,
                maxBodyLength: config.maxBodyLength || 128 * 1024,
                maxContentLength: config.maxContentLength || 2 * 1024 * 1024
            });
        } catch (error) {
            const status = Number(error.response?.status || 0);
            if (status === 401 || status === 403) {
                throw httpError(
                    503,
                    'Delhivery authentication was rejected. Check the server API token/environment.',
                    'DELHIVERY_AUTH'
                );
            }
            if (error.status) throw error;
            const message = clean(
                error.response?.data?.message ||
                error.response?.data?.detail ||
                error.message ||
                'Delhivery serviceability is temporarily unavailable.',
                500
            );
            throw httpError(
                status >= 400 && status < 500 ? 409 : 502,
                message || 'Delhivery serviceability is temporarily unavailable.',
                'DELHIVERY_UNAVAILABLE'
            );
        }
    }

    async function loadSellerLocation(sellerId, locationId) {
        if (!uuid(locationId)) {
            throw httpError(400, 'Choose a valid seller pickup location.', 'PICKUP_LOCATION');
        }
        const rows = await query(
            `SELECT id,seller_id,location_name,address_line1,address_line2,city,district,state,pincode,
                    is_active,is_default,
                    delhivery_pickup_serviceable,delhivery_delivery_serviceable,
                    delhivery_prepaid_serviceable,delhivery_cod_serviceable,
                    delhivery_serviceability_checked_at,delhivery_serviceability_error,
                    delhivery_serviceability_response
               FROM public.cerood_seller_locations
              WHERE id=? AND seller_id=? AND is_active=true
              LIMIT 1`,
            [locationId, sellerId]
        );
        if (!rows.length) {
            throw httpError(404, 'Seller pickup location was not found.', 'PICKUP_NOT_FOUND');
        }
        const row = rows[0];
        const pin = pin6(row.pincode);
        if (!/^[1-9]\d{5}$/.test(pin)) {
            throw httpError(409, 'Pickup location needs a valid 6-digit pincode.', 'PICKUP_PINCODE');
        }
        row.pincode = pin;
        return row;
    }

    function parseServiceabilityResponse(data, requestedPin) {
        const list = Array.isArray(data?.delivery_codes) ? data.delivery_codes : [];
        const row = list
            .map(x => x?.postal_code || x)
            .find(x => String(x?.pin || '') === String(requestedPin)) ||
            (list[0]?.postal_code || list[0] || null);

        if (!row || typeof row !== 'object') {
            return {
                pincode: String(requestedPin),
                seller_pickup: false,
                customer_delivery: false,
                prepaid_available: false,
                cod_available: false,
                serviceable: false,
                remarks: 'Pincode not returned by Delhivery.'
            };
        }

        const remarks = clean(row.remarks, 250);
        const embargo = /embargo/i.test(remarks);
        const pickup = yes(row.pickup);
        const prepaid = yes(row.pre_paid);
        const cod = yes(row.cod) || yes(row.cash);
        const delivery = (prepaid || cod) && !embargo;

        return {
            pincode: String(row.pin || requestedPin),
            seller_pickup: pickup && !embargo,
            customer_delivery: delivery,
            prepaid_available: prepaid && !embargo,
            cod_available: cod && !embargo,
            serviceable: (pickup || delivery) && !embargo,
            city: clean(row.city, 120) || null,
            district: clean(row.district, 120) || null,
            state_code: clean(row.state_code, 20) || null,
            center: clean(row.inc, 160) || null,
            remarks: remarks || null,
            embargo
        };
    }

    async function liveServiceability(location) {
        const pin = pin6(location.pincode);
        const response = await delhiveryRequest({
            method: 'GET',
            url: '/c/api/pin-codes/json/',
            params: { filter_codes: pin }
        });
        return {
            parsed: parseServiceabilityResponse(response.data, pin),
            raw: response.data
        };
    }

    async function saveServiceability(location, result) {
        const p = result.parsed;
        await query(
            `UPDATE public.cerood_seller_locations
                SET delhivery_pickup_serviceable=?,
                    delhivery_delivery_serviceable=?,
                    delhivery_prepaid_serviceable=?,
                    delhivery_cod_serviceable=?,
                    delhivery_serviceability_checked_at=NOW(),
                    delhivery_serviceability_error=NULL,
                    delhivery_serviceability_response=?::jsonb,
                    updated_at=NOW()
              WHERE id=? AND seller_id=?`,
            [
                p.seller_pickup,
                p.customer_delivery,
                p.prepaid_available,
                p.cod_available,
                JSON.stringify(result.raw || {}),
                location.id,
                location.seller_id
            ]
        );
        return p;
    }

    async function saveServiceabilityError(location, message) {
        await query(
            `UPDATE public.cerood_seller_locations
                SET delhivery_serviceability_error=?,
                    delhivery_serviceability_checked_at=NOW(),
                    updated_at=NOW()
              WHERE id=? AND seller_id=?`,
            [clean(message, 1000), location.id, location.seller_id]
        ).catch(() => {});
    }

    function publicDelhivery(row) {
        return {
            seller_pickup: row.delhivery_pickup_serviceable === null || row.delhivery_pickup_serviceable === undefined
                ? null : Boolean(row.delhivery_pickup_serviceable),
            customer_delivery: row.delhivery_delivery_serviceable === null || row.delhivery_delivery_serviceable === undefined
                ? null : Boolean(row.delhivery_delivery_serviceable),
            prepaid_available: row.delhivery_prepaid_serviceable === null || row.delhivery_prepaid_serviceable === undefined
                ? null : Boolean(row.delhivery_prepaid_serviceable),
            cod_available: row.delhivery_cod_serviceable === null || row.delhivery_cod_serviceable === undefined
                ? null : Boolean(row.delhivery_cod_serviceable),
            checked_at: row.delhivery_serviceability_checked_at || null,
            error: row.delhivery_serviceability_error || null
        };
    }

    function isFresh(row) {
        const checked = new Date(row.delhivery_serviceability_checked_at || 0).getTime();
        return checked > Date.now() - TTL_HOURS * 60 * 60 * 1000;
    }

    app.get('/api/sellers/delhivery/status', requireSellerAuth, async (req, res) => {
        try {
            await ensureSchema();
            return res.json({
                success: true,
                configured: Boolean(String(process.env.DELHIVERY_API_TOKEN || '').trim()),
                environment: DELHIVERY_BASE_URL.includes('staging-') ? 'staging' : 'production',
                cache_hours: TTL_HOURS
            });
        } catch (error) {
            return res.status(503).json({
                success: false,
                configured: false,
                message: 'Delhivery shipping schema is unavailable.'
            });
        }
    });

    app.get('/api/sellers/delhivery/locations', requireSellerAuth, async (req, res) => {
        try {
            await ensureSchema();
            const rows = await query(
                `SELECT id,seller_id,location_name,address_line1,address_line2,city,district,state,pincode,
                        is_active,is_default,
                        delhivery_pickup_serviceable,delhivery_delivery_serviceable,
                        delhivery_prepaid_serviceable,delhivery_cod_serviceable,
                        delhivery_serviceability_checked_at,delhivery_serviceability_error
                   FROM public.cerood_seller_locations
                  WHERE seller_id=? AND is_active=true
                  ORDER BY is_default DESC,created_at ASC`,
                [req.seller.id]
            );
            return res.json({
                success: true,
                configured: Boolean(String(process.env.DELHIVERY_API_TOKEN || '').trim()),
                locations: rows.map(row => ({ ...row, delhivery: publicDelhivery(row) }))
            });
        } catch (error) {
            console.error('Delhivery locations:', error.code || error.message);
            return res.status(500).json({ success: false, message: 'Unable to load Delhivery pickup availability.' });
        }
    });

    app.post('/api/sellers/locations/:id/delhivery-serviceability', requireSellerAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        let location;
        try {
            await ensureSchema();
            location = await loadSellerLocation(req.seller.id, req.params.id);
            const force = req.body?.force !== false;
            if (!force && isFresh(location)) {
                return res.json({
                    success: true,
                    cached: true,
                    serviceability: publicDelhivery(location),
                    message: location.delhivery_pickup_serviceable
                        ? `Delhivery pickup is available from ${location.pincode}.`
                        : `Delhivery pickup is unavailable from ${location.pincode}.`
                });
            }

            const result = await liveServiceability(location);
            const saved = await saveServiceability(location, result);
            return res.json({
                success: true,
                cached: false,
                serviceability: { ...saved, checked_at: new Date().toISOString(), error: null },
                message: saved.seller_pickup
                    ? `Delhivery pickup is available from ${location.pincode}.`
                    : `Delhivery pickup is unavailable from ${location.pincode}.`
            });
        } catch (error) {
            if (location) await saveServiceabilityError(location, error.message);
            console.error('Delhivery serviceability:', error.code || error.message);
            return res.status(error.status || 502).json({
                success: false,
                code: error.code || undefined,
                message: error.message || 'Unable to check Delhivery pickup availability.'
            });
        }
    });

    return {
        ensureSchema,
        liveServiceability
    };
};
