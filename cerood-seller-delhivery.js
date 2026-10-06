'use strict';

// ============================================================
// CEROOD × DELHIVERY — MULTI-VENDOR SHIPPING (PHASE 2)
//
// Per-seller pickup pincode serviceability + warehouse registration
// + B2C shipment manifestation + warehouse pickup request + tracking.
//
// Required private environment variables:
//   DELHIVERY_API_TOKEN
//   DELHIVERY_CLIENT_NAME   (exact Delhivery client name; case-sensitive)
//
// Optional:
//   DELHIVERY_BASE_URL=https://track.delhivery.com
//   DELHIVERY_SERVICEABILITY_TTL_HOURS=24
//   DELHIVERY_PICKUP_TIME=14:00:00
//   DELHIVERY_AUTO_PICKUP_REQUEST=true
//   DELHIVERY_DEFAULT_WAREHOUSE_EMAIL=
//   DELHIVERY_DEFAULT_HSN_CODE=
//
// Notes:
// - Browser never receives the API token.
// - One physical shipment is created per marketplace + order + seller
//   + fulfilment location, matching the existing Ekart grouping model.
// - CEROOD customer-facing delivery status is never auto-overwritten.
// ============================================================

const axios = require('axios');
const crypto = require('crypto');

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

    const MARKETPLACES = Object.freeze({
        renewed: {
            itemTable: 'renewed_order_items',
            orderTable: 'renewed_orders',
            lineColumn: 'line_total'
        },
        cosmetics: {
            itemTable: 'cosmetics_order_items',
            orderTable: 'cosmetics_orders',
            lineColumn: 'total_price'
        },
        clothing: {
            itemTable: 'clothing_order_items',
            orderTable: 'clothing_orders',
            lineColumn: 'total_price'
        },
        shop: {
            itemTable: 'cerood_shop_order_items',
            orderTable: 'cerood_shop_orders',
            lineColumn: 'line_total'
        }
    });

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

    // Delhivery's legacy manifestation API rejects these characters in
    // several text fields. Keep seller/customer data readable and safe.
    const dlText = (value, max = 250) => clean(value, max)
        .replace(/[&#%;\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);

    const digits = value => String(value ?? '').replace(/\D/g, '');
    const pin6 = value => digits(value).slice(0, 6);
    const phone10 = value => digits(value).replace(/^91(?=[6-9]\d{9}$)/, '').slice(-10);
    const validPhone = value => /^[6-9]\d{9}$/.test(phone10(value));
    const yes = value => String(value ?? '').trim().toUpperCase() === 'Y';
    const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(String(value || '').trim());
    const money = value => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : NaN;
    };

    function httpError(status, message, code) {
        const error = new Error(message);
        error.status = status;
        if (code) error.code = code;
        return error;
    }

    function parseJsonObject(value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            } catch (_) {}
        }
        return {};
    }

    function parseOrderItemRef(raw) {
        const value = String(raw || '').trim();
        if (/^[1-9]\d*$/.test(value)) {
            const id = Number(value);
            return Number.isSafeInteger(id) ? { marketplace: 'renewed', id, raw: value } : null;
        }
        const match = /^(cosmetics|clothing|shop):([1-9]\d*)$/.exec(value);
        if (!match) return null;
        const id = Number(match[2]);
        return Number.isSafeInteger(id)
            ? { marketplace: match[1], id, raw: value }
            : null;
    }

    function itemRef(marketplace, id) {
        return marketplace === 'renewed' ? String(id) : `${marketplace}:${id}`;
    }

    function orderConfirmed(marketplace, order) {
        const paymentMethod = String(order?.payment_method || '').toLowerCase();
        const status = String(order?.order_status ?? order?.delivery_status ?? '').toLowerCase();
        const paymentStatus = String(order?.payment_status || '').toLowerCase();
        const bad = new Set(['cancelled', 'canceled', 'failed', 'refunded', 'expired']);
        if (bad.has(status)) return false;

        if (marketplace === 'renewed') {
            return paymentMethod === 'cod'
                ? paymentStatus === 'processing'
                : paymentStatus === 'paid';
        }

        if (paymentMethod === 'cod') return !bad.has(status);
        return ['paid', 'captured', 'success', 'payment_review'].includes(paymentStatus);
    }

    function customerLocation(order) {
        const a = parseJsonObject(order.delivery_address);
        const name = dlText(a.full_name || a.name || order.customer_name, 100);
        const phone = phone10(a.phone || order.customer_phone);
        const pin = pin6(a.pincode || a.pin || a.pin_code || a.postal_code);
        const city = dlText(a.city || a.village || a.town || a.district, 100);
        const state = dlText(a.state, 100);
        const address = dlText([
            a.house,
            a.address_line1,
            a.street,
            a.area,
            a.village && a.village !== city ? a.village : '',
            a.address_line2,
            a.landmark,
            a.district
        ].filter(Boolean).join(', '), 250);

        if (!name || !validPhone(phone) || !/^[1-9]\d{5}$/.test(pin) || !address || !state) {
            throw httpError(409, 'Customer delivery address is incomplete for Delhivery shipment booking.', 'CUSTOMER_ADDRESS');
        }

        return { name, phone, pin, address, city, state, country: 'India' };
    }

    // ------------------------------------------------------------
    // Database schema.
    // ------------------------------------------------------------
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
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_serviceability_response JSONB`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_warehouse_name VARCHAR(180)`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_warehouse_registered_at TIMESTAMPTZ`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS delhivery_warehouse_error TEXT`,

                    `CREATE TABLE IF NOT EXISTS public.cerood_delhivery_shipments (
                        id UUID PRIMARY KEY,
                        shipment_group_key VARCHAR(420) NOT NULL UNIQUE,
                        marketplace VARCHAR(30) NOT NULL,
                        order_id TEXT NOT NULL,
                        seller_id UUID NOT NULL REFERENCES public.cerood_sellers(id),
                        fulfilment_location_id UUID NOT NULL REFERENCES public.cerood_seller_locations(id),
                        idempotency_key VARCHAR(220),
                        booking_state VARCHAR(40) NOT NULL DEFAULT 'creating',
                        waybill VARCHAR(140),
                        delhivery_order_id VARCHAR(60) NOT NULL,
                        warehouse_name VARCHAR(180),
                        payment_mode VARCHAR(20) NOT NULL,
                        cod_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
                        shipment_value NUMERIC(14,2) NOT NULL,
                        quantity INTEGER NOT NULL,
                        weight_g INTEGER NOT NULL,
                        length_cm INTEGER NOT NULL,
                        width_cm INTEGER NOT NULL,
                        height_cm INTEGER NOT NULL,
                        package_description VARCHAR(500),
                        hsn_code VARCHAR(120),
                        order_item_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
                        shipment_items JSONB NOT NULL DEFAULT '[]'::jsonb,
                        serviceability_response JSONB,
                        delhivery_response JSONB,
                        pickup_request_id VARCHAR(160),
                        pickup_request_response JSONB,
                        pickup_requested_at TIMESTAMPTZ,
                        last_tracking JSONB,
                        last_tracking_status VARCHAR(160),
                        last_error TEXT,
                        booking_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        booked_at TIMESTAMPTZ,
                        last_tracking_at TIMESTAMPTZ,
                        cancelled_at TIMESTAMPTZ,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )`,
                    `CREATE INDEX IF NOT EXISTS cerood_delhivery_shipments_seller_order_idx
                        ON public.cerood_delhivery_shipments(seller_id, marketplace, order_id, updated_at DESC)`,
                    `CREATE INDEX IF NOT EXISTS cerood_delhivery_shipments_waybill_idx
                        ON public.cerood_delhivery_shipments(waybill) WHERE waybill IS NOT NULL`,

                    `CREATE TABLE IF NOT EXISTS public.cerood_delhivery_pickup_requests (
                        id UUID PRIMARY KEY,
                        seller_id UUID NOT NULL REFERENCES public.cerood_sellers(id),
                        fulfilment_location_id UUID NOT NULL REFERENCES public.cerood_seller_locations(id),
                        warehouse_name VARCHAR(180) NOT NULL,
                        pickup_date DATE NOT NULL,
                        pickup_time TIME NOT NULL,
                        expected_package_count INTEGER NOT NULL DEFAULT 1,
                        status VARCHAR(40) NOT NULL DEFAULT 'requested',
                        delhivery_pickup_id VARCHAR(160),
                        response JSONB,
                        last_error TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        UNIQUE(fulfilment_location_id, pickup_date)
                    )`
                ];
                for (const sql of statements) await query(sql);
            })().catch(error => {
                schemaPromise = null;
                throw error;
            });
        }
        return schemaPromise;
    }

    // ------------------------------------------------------------
    // Delhivery HTTP client.
    // ------------------------------------------------------------
    function delhiveryConfig(requireClient = false) {
        const token = String(process.env.DELHIVERY_API_TOKEN || '').trim();
        const clientName = clean(process.env.DELHIVERY_CLIENT_NAME, 180);
        if (!token) {
            throw httpError(503, 'Delhivery API token is not configured on the server.', 'DELHIVERY_CONFIG');
        }
        if (requireClient && !clientName) {
            throw httpError(503, 'DELHIVERY_CLIENT_NAME is not configured. Add the exact case-sensitive Delhivery client name in Render.', 'DELHIVERY_CLIENT_NAME');
        }
        return { token, clientName };
    }

    function safeDelhiveryMessage(error, fallback) {
        const data = error?.response?.data;
        const candidate = clean(
            data?.message || data?.detail || data?.error || data?.rmk ||
            (typeof data === 'string' ? data : '') || error?.message || fallback,
            900
        );
        return candidate || fallback;
    }

    async function delhiveryRequest(config, requireClient = false) {
        const { token } = delhiveryConfig(requireClient);
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
                maxBodyLength: config.maxBodyLength || 512 * 1024,
                maxContentLength: config.maxContentLength || 4 * 1024 * 1024
            });
        } catch (error) {
            const status = Number(error.response?.status || 0);
            if (status === 401 || status === 403) {
                throw httpError(
                    503,
                    'Delhivery authentication was rejected. Check the API token and production/staging environment.',
                    'DELHIVERY_AUTH'
                );
            }
            if (error.status) throw error;
            throw httpError(
                status >= 400 && status < 500 ? 409 : 502,
                safeDelhiveryMessage(error, 'Delhivery is temporarily unavailable.'),
                'DELHIVERY_UNAVAILABLE'
            );
        }
    }

    // ------------------------------------------------------------
    // Seller location + serviceability.
    // ------------------------------------------------------------
    async function loadSellerLocation(sellerId, locationId) {
        if (!uuid(locationId)) {
            throw httpError(400, 'Choose a valid seller pickup location.', 'PICKUP_LOCATION');
        }
        const rows = await query(
            `SELECT l.id,l.seller_id,l.location_name,l.address_line1,l.address_line2,l.city,l.district,l.state,l.pincode,
                    l.is_active,l.is_default,
                    l.delhivery_pickup_serviceable,l.delhivery_delivery_serviceable,
                    l.delhivery_prepaid_serviceable,l.delhivery_cod_serviceable,
                    l.delhivery_serviceability_checked_at,l.delhivery_serviceability_error,
                    l.delhivery_serviceability_response,l.delhivery_warehouse_name,
                    l.delhivery_warehouse_registered_at,l.delhivery_warehouse_error,
                    s.owner_name,s.shop_name,s.phone,s.email,s.gst_number,s.status AS seller_status
               FROM public.cerood_seller_locations l
               JOIN public.cerood_sellers s ON s.id=l.seller_id
              WHERE l.id=? AND l.seller_id=? AND l.is_active=true
              LIMIT 1`,
            [locationId, sellerId]
        );
        if (!rows.length) {
            throw httpError(404, 'Seller pickup location was not found.', 'PICKUP_NOT_FOUND');
        }
        const row = rows[0];
        if (row.seller_status !== 'approved') {
            throw httpError(409, 'Seller account must be approved before courier booking.', 'SELLER_NOT_APPROVED');
        }
        const pin = pin6(row.pincode);
        if (!/^[1-9]\d{5}$/.test(pin)) {
            throw httpError(409, 'Pickup location needs a valid 6-digit pincode.', 'PICKUP_PINCODE');
        }
        const phone = phone10(row.phone);
        if (!validPhone(phone) || !clean(row.address_line1, 250) || !clean(row.state, 100)) {
            throw httpError(409, 'Complete seller pickup address, state and phone before Delhivery booking.', 'PICKUP_INCOMPLETE');
        }
        row.pincode = pin;
        row.phone = phone;
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

    async function livePincodeServiceability(pin) {
        const requestedPin = pin6(pin);
        if (!/^[1-9]\d{5}$/.test(requestedPin)) {
            throw httpError(400, 'Invalid 6-digit pincode.', 'PINCODE');
        }
        const response = await delhiveryRequest({
            method: 'GET',
            url: '/c/api/pin-codes/json/',
            params: { filter_codes: requestedPin }
        });
        return {
            parsed: parseServiceabilityResponse(response.data, requestedPin),
            raw: response.data
        };
    }

    async function liveServiceability(location) {
        return livePincodeServiceability(location.pincode);
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
            error: row.delhivery_serviceability_error || null,
            warehouse_name: row.delhivery_warehouse_name || null,
            warehouse_registered_at: row.delhivery_warehouse_registered_at || null,
            warehouse_error: row.delhivery_warehouse_error || null
        };
    }

    function isFresh(row) {
        const checked = new Date(row.delhivery_serviceability_checked_at || 0).getTime();
        return checked > Date.now() - TTL_HOURS * 60 * 60 * 1000;
    }

    async function refreshPickupServiceability(location, force = false) {
        if (!force && isFresh(location) && typeof location.delhivery_pickup_serviceable === 'boolean') {
            return publicDelhivery(location);
        }
        try {
            const result = await liveServiceability(location);
            const saved = await saveServiceability(location, result);
            return {
                ...saved,
                checked_at: new Date().toISOString(),
                error: null,
                warehouse_name: location.delhivery_warehouse_name || null,
                warehouse_registered_at: location.delhivery_warehouse_registered_at || null,
                warehouse_error: location.delhivery_warehouse_error || null
            };
        } catch (error) {
            await saveServiceabilityError(location, error.message);
            throw error;
        }
    }

    async function requirePickupServiceable(location, force = false) {
        const result = await refreshPickupServiceability(location, force);
        if (result.seller_pickup !== true) {
            throw httpError(
                409,
                `Delhivery pickup is unavailable from seller pincode ${location.pincode}.`,
                'DELHIVERY_PICKUP_UNAVAILABLE'
            );
        }
        return result;
    }

    // ------------------------------------------------------------
    // Warehouse registration.
    // ------------------------------------------------------------
    function warehouseName(location) {
        if (clean(location.delhivery_warehouse_name, 180)) {
            return clean(location.delhivery_warehouse_name, 180);
        }
        const seller = String(location.seller_id || '').replace(/-/g, '').slice(0, 10).toUpperCase();
        const loc = String(location.id || '').replace(/-/g, '').slice(0, 10).toUpperCase();
        return `CEROOD_${seller}_${loc}`.slice(0, 180);
    }

    function warehouseAddress(location) {
        return dlText([
            location.address_line1,
            location.address_line2,
            location.city,
            location.district,
            location.state
        ].filter(Boolean).join(', '), 250);
    }

    async function ensureWarehouse(location) {
        if (clean(location.delhivery_warehouse_name, 180) && location.delhivery_warehouse_registered_at) {
            return clean(location.delhivery_warehouse_name, 180);
        }

        await requirePickupServiceable(location, false);

        const name = warehouseName(location);
        const email = clean(location.email || process.env.DELHIVERY_DEFAULT_WAREHOUSE_EMAIL, 180);
        if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
            throw httpError(
                409,
                'Seller email is required to register this Delhivery warehouse. Add seller email or DELHIVERY_DEFAULT_WAREHOUSE_EMAIL.',
                'DELHIVERY_WAREHOUSE_EMAIL'
            );
        }

        const address = warehouseAddress(location);
        const city = dlText(location.city || location.district, 100);
        const state = dlText(location.state, 100);
        const payload = {
            phone: String(phone10(location.phone)),
            city,
            name,
            pin: String(pin6(location.pincode)),
            address,
            country: 'India',
            email,
            registered_name: name,
            return_address: address,
            return_pin: String(pin6(location.pincode)),
            return_city: city,
            return_state: state,
            return_country: 'India'
        };

        try {
            const response = await delhiveryRequest({
                method: 'POST',
                url: '/api/backend/clientwarehouse/create/',
                data: payload,
                headers: { 'Content-Type': 'application/json' },
                timeout: 25_000
            });
            const body = response.data || {};
            const bodyText = clean(typeof body === 'string' ? body : JSON.stringify(body), 1500);
            const rejected = body?.success === false || /error|invalid|failed/i.test(clean(body?.error || body?.message || body?.remark, 500));
            if (rejected) {
                throw httpError(409, clean(body?.error || body?.message || body?.remark || 'Delhivery rejected warehouse creation.', 700), 'DELHIVERY_WAREHOUSE_REJECTED');
            }

            await query(
                `UPDATE public.cerood_seller_locations
                    SET delhivery_warehouse_name=?,delhivery_warehouse_registered_at=NOW(),
                        delhivery_warehouse_error=NULL,updated_at=NOW()
                  WHERE id=? AND seller_id=?`,
                [name, location.id, location.seller_id]
            );
            return name;
        } catch (error) {
            const message = safeDelhiveryMessage(error, 'Delhivery warehouse registration failed.');
            // A deterministic name means an already-existing warehouse can safely be reused.
            if (/already\s+(exists|created)|warehouse.*exists|duplicate/i.test(message)) {
                await query(
                    `UPDATE public.cerood_seller_locations
                        SET delhivery_warehouse_name=?,delhivery_warehouse_registered_at=COALESCE(delhivery_warehouse_registered_at,NOW()),
                            delhivery_warehouse_error=NULL,updated_at=NOW()
                      WHERE id=? AND seller_id=?`,
                    [name, location.id, location.seller_id]
                );
                return name;
            }
            await query(
                `UPDATE public.cerood_seller_locations
                    SET delhivery_warehouse_error=?,updated_at=NOW()
                  WHERE id=? AND seller_id=?`,
                [message, location.id, location.seller_id]
            ).catch(() => {});
            if (error.status) throw error;
            throw httpError(409, message, 'DELHIVERY_WAREHOUSE');
        }
    }

    // ------------------------------------------------------------
    // Authoritative order parcel loading.
    // ------------------------------------------------------------
    async function loadParcel(ref, sellerId, selectedLocationId) {
        const cfg = MARKETPLACES[ref.marketplace];
        if (!cfg) throw httpError(400, 'Unsupported marketplace order item.', 'ORDER_ITEM');

        let requestRows;
        if (ref.marketplace === 'renewed') {
            requestRows = await query(
                `SELECT oi.id,oi.order_id,oi.seller_id,oi.product_id,oi.product_name,oi.quantity,oi.unit_price,
                        oi.line_total,oi.fulfilment_location_id,COALESCE(oi.seller_order_status,'new') AS seller_order_status,
                        o.customer_name,o.customer_phone,o.delivery_address,o.subtotal,o.delivery_fee,o.total,
                        o.payment_method,o.status AS payment_status,o.delivery_status AS order_status,o.created_at
                   FROM public.renewed_order_items oi
                   JOIN public.renewed_orders o ON o.id=oi.order_id
                  WHERE oi.id=? AND oi.seller_id=? LIMIT 1`,
                [ref.id, sellerId]
            );
        } else {
            const lineColumn = cfg.lineColumn;
            requestRows = await query(
                `SELECT oi.id,oi.order_id,oi.seller_id,oi.product_id,oi.product_name,oi.quantity,oi.unit_price,
                        oi.${lineColumn} AS line_total,oi.fulfilment_location_id,
                        COALESCE(oi.seller_order_status,'new') AS seller_order_status,
                        o.customer_name,o.customer_phone,o.delivery_address,o.subtotal,o.delivery_fee,o.total,
                        o.payment_method,o.payment_status,o.status AS order_status,o.created_at
                   FROM public.${cfg.itemTable} oi
                   JOIN public.${cfg.orderTable} o ON o.id=oi.order_id
                  WHERE oi.id=? AND oi.seller_id=? LIMIT 1`,
                [ref.id, sellerId]
            );
        }

        if (!requestRows.length) throw httpError(404, 'Seller order item was not found.', 'ORDER_NOT_FOUND');
        const requested = requestRows[0];
        if (!orderConfirmed(ref.marketplace, requested)) {
            throw httpError(409, 'This order is not in a confirmed/shippable payment state.', 'ORDER_NOT_CONFIRMED');
        }
        if (!['packed', 'shipped'].includes(String(requested.seller_order_status || '').toLowerCase())) {
            throw httpError(409, 'Mark the seller item as packed before arranging courier pickup.', 'NOT_PACKED');
        }

        const lockedLocation = String(requested.fulfilment_location_id || '');
        if (lockedLocation && lockedLocation !== String(selectedLocationId)) {
            throw httpError(409, 'This item is assigned to a different seller pickup location.', 'PICKUP_MISMATCH');
        }

        const lineColumn = cfg.lineColumn;
        const groupItems = await query(
            `SELECT id,order_id,seller_id,product_id,product_name,quantity,unit_price,
                    ${lineColumn} AS line_total,fulfilment_location_id,
                    COALESCE(seller_order_status,'new') AS seller_order_status
               FROM public.${cfg.itemTable}
              WHERE order_id=? AND seller_id=?
                AND COALESCE(seller_order_status,'new')<>'rejected'
                AND (fulfilment_location_id IS NULL OR fulfilment_location_id=?)
              ORDER BY id ASC`,
            [requested.order_id, sellerId, selectedLocationId]
        );

        if (!groupItems.length || !groupItems.some(x => Number(x.id) === ref.id)) {
            throw httpError(409, 'No shippable seller items were found for this pickup location.', 'NO_GROUP_ITEMS');
        }

        const waiting = groupItems.filter(x => !['packed', 'shipped'].includes(String(x.seller_order_status || '').toLowerCase()));
        if (waiting.length) {
            throw httpError(409, `Pack all ${groupItems.length} seller item(s) assigned to this pickup before creating one courier shipment.`, 'GROUP_NOT_READY');
        }

        const ids = groupItems.map(x => Number(x.id)).filter(Number.isSafeInteger);
        if (ids.length) {
            const placeholders = ids.map(() => '?').join(',');
            await query(
                `UPDATE public.${cfg.itemTable}
                    SET fulfilment_location_id=?
                  WHERE id IN (${placeholders}) AND seller_id=? AND fulfilment_location_id IS NULL`,
                [selectedLocationId, ...ids, sellerId]
            );
            for (const row of groupItems) if (!row.fulfilment_location_id) row.fulfilment_location_id = selectedLocationId;
        }

        const sellerSubtotal = money(groupItems.reduce((sum, x) => sum + Number(x.line_total || 0), 0));
        if (!Number.isFinite(sellerSubtotal) || sellerSubtotal <= 0) {
            throw httpError(409, 'Stored seller order amount is invalid.', 'ORDER_AMOUNT');
        }

        const allLineRows = await query(
            `SELECT COALESCE(SUM(${lineColumn}),0)::numeric AS line_total
               FROM public.${cfg.itemTable}
              WHERE order_id=?`,
            [requested.order_id]
        );
        const originalLineTotal = money(allLineRows[0]?.line_total || 0);
        const orderTotal = money(requested.total);
        const adjustment = Number.isFinite(orderTotal) && Number.isFinite(originalLineTotal)
            ? money(orderTotal - originalLineTotal)
            : 0;

        const sellerRows = await query(
            `SELECT seller_id::text AS seller_id
               FROM public.${cfg.itemTable}
              WHERE order_id=? AND seller_id IS NOT NULL
                AND COALESCE(seller_order_status,'new')<>'rejected'
              GROUP BY seller_id
              ORDER BY seller_id::text ASC`,
            [requested.order_id]
        );
        const firstActiveSeller = String(sellerRows[0]?.seller_id || '');
        const allocatedAdjustment = firstActiveSeller === String(sellerId) ? adjustment : 0;
        const shipmentValue = money(sellerSubtotal + allocatedAdjustment);
        if (!Number.isFinite(shipmentValue) || shipmentValue < 1) {
            throw httpError(409, 'Shipment invoice amount is invalid after order adjustments.', 'SHIPMENT_VALUE');
        }

        const paymentMode = String(requested.payment_method || '').toLowerCase() === 'cod' ? 'COD' : 'Pre-paid';
        const codAmount = paymentMode === 'COD' ? shipmentValue : 0;

        return {
            marketplace: ref.marketplace,
            orderId: String(requested.order_id),
            sellerId: String(sellerId),
            requested,
            items: groupItems,
            sellerSubtotal,
            allocatedAdjustment,
            shipmentValue,
            paymentMode,
            codAmount,
            quantity: groupItems.reduce((sum, x) => sum + Number(x.quantity || 0), 0),
            customer: customerLocation(requested),
            fulfilmentLocationId: String(selectedLocationId)
        };
    }

    function shipmentGroupKey(parcel) {
        return `${parcel.marketplace}:${parcel.orderId}:${parcel.sellerId}:${parcel.fulfilmentLocationId}`.slice(0, 420);
    }

    function externalOrderNumber(parcel) {
        const m = ({ renewed: 'REN', cosmetics: 'BEA', clothing: 'FAS', shop: 'SHOP' })[parcel.marketplace] || 'ORD';
        const order = parcel.orderId.replace(/[^A-Za-z0-9]/g, '').slice(-18).toUpperCase();
        const seller = parcel.sellerId.replace(/-/g, '').slice(0, 8).toUpperCase();
        const loc = parcel.fulfilmentLocationId.replace(/-/g, '').slice(0, 6).toUpperCase();
        return `CE-${m}-${order}-${seller}-${loc}`.slice(0, 50);
    }

    function bookingInput(body = {}) {
        const weightG = Math.ceil(Number(body.weight_g));
        const lengthCm = Math.ceil(Number(body.length_cm));
        const widthCm = Math.ceil(Number(body.width_cm ?? body.breadth_cm));
        const heightCm = Math.ceil(Number(body.height_cm));
        const locationId = String(body.fulfilment_location_id || '').trim();
        const description = dlText(body.package_description, 250);
        const hsnCode = dlText(body.hsn_code || process.env.DELHIVERY_DEFAULT_HSN_CODE, 120);

        if (!uuid(locationId)) throw httpError(400, 'Choose a valid seller pickup location.', 'PICKUP_LOCATION');
        if (!Number.isSafeInteger(weightG) || weightG < 1 || weightG > 100000) {
            throw httpError(400, 'Packed weight must be between 1 and 100000 grams.', 'WEIGHT');
        }
        for (const [label, value] of [['length', lengthCm], ['width', widthCm], ['height', heightCm]]) {
            if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
                throw httpError(400, `Parcel ${label} must be between 1 and 500 cm.`, 'DIMENSIONS');
            }
        }
        if (!hsnCode) {
            throw httpError(
                409,
                'HSN code is required for Delhivery manifestation. Enter the actual HSN from the product/invoice or configure a valid product HSN in CEROOD.',
                'HSN_REQUIRED'
            );
        }
        return { locationId, weightG, lengthCm, widthCm, heightCm, description, hsnCode };
    }

    function publicShipment(row) {
        if (!row) return null;
        const waybill = clean(row.waybill, 140) || null;
        return {
            id: row.id,
            provider: 'delhivery',
            marketplace: row.marketplace,
            order_id: row.order_id,
            seller_id: row.seller_id,
            fulfilment_location_id: row.fulfilment_location_id,
            booking_state: row.booking_state,
            awb: waybill,
            waybill,
            tracking_id: waybill,
            status: row.last_tracking_status || row.booking_state,
            warehouse_name: row.warehouse_name || null,
            payment_mode: row.payment_mode || null,
            cod_amount: Number(row.cod_amount || 0),
            shipment_value: Number(row.shipment_value || 0),
            weight_g: Number(row.weight_g || 0),
            length_cm: Number(row.length_cm || 0),
            width_cm: Number(row.width_cm || 0),
            height_cm: Number(row.height_cm || 0),
            pickup_request_id: row.pickup_request_id || null,
            pickup_requested_at: row.pickup_requested_at || null,
            last_tracking_status: row.last_tracking_status || null,
            booked_at: row.booked_at || null,
            last_tracking_at: row.last_tracking_at || null,
            cancelled_at: row.cancelled_at || null,
            label_endpoint: waybill ? `/api/seller/orders/${encodeURIComponent(row.order_item_refs?.[0] || '')}/delhivery-label` : null
        };
    }

    async function reserveBooking(parcel, input, idempotencyKey) {
        const groupKey = shipmentGroupKey(parcel);
        const id = crypto.randomUUID();
        let client;
        try {
            client = await db.getClient();
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [groupKey]);

            const existingRows = await client.query(
                `SELECT * FROM public.cerood_delhivery_shipments WHERE shipment_group_key=$1 FOR UPDATE`,
                [groupKey]
            );
            const current = existingRows[0];
            if (current) {
                if (current.waybill || ['booked', 'pickup_scheduled', 'in_transit', 'out_for_delivery', 'delivered'].includes(String(current.booking_state || '').toLowerCase())) {
                    await client.query('COMMIT');
                    return { existing: true, row: current };
                }
                if (String(current.booking_state) === 'booking_unknown') {
                    await client.query('COMMIT');
                    throw httpError(409, 'A previous Delhivery booking attempt has an unknown result. Verify Delhivery before retrying to avoid duplicate AWB.', 'DELHIVERY_BOOKING_UNKNOWN');
                }
                if (String(current.booking_state) === 'creating' && new Date(current.updated_at || current.booking_started_at).getTime() > Date.now() - 10 * 60_000) {
                    await client.query('COMMIT');
                    throw httpError(409, 'Delhivery shipment creation is already in progress for this seller parcel.', 'DELHIVERY_BOOKING_IN_PROGRESS');
                }

                const rows = await client.query(
                    `UPDATE public.cerood_delhivery_shipments
                        SET idempotency_key=$2,booking_state='creating',waybill=NULL,
                            fulfilment_location_id=$3,payment_mode=$4,cod_amount=$5,shipment_value=$6,
                            quantity=$7,weight_g=$8,length_cm=$9,width_cm=$10,height_cm=$11,
                            package_description=$12,hsn_code=$13,order_item_refs=$14::jsonb,shipment_items=$15::jsonb,
                            last_error=NULL,booking_started_at=NOW(),updated_at=NOW()
                      WHERE id=$1 RETURNING *`,
                    [
                        current.id,
                        idempotencyKey,
                        parcel.fulfilmentLocationId,
                        parcel.paymentMode,
                        parcel.codAmount,
                        parcel.shipmentValue,
                        parcel.quantity,
                        input.weightG,
                        input.lengthCm,
                        input.widthCm,
                        input.heightCm,
                        input.description,
                        input.hsnCode,
                        JSON.stringify(parcel.items.map(x => itemRef(parcel.marketplace, x.id))),
                        JSON.stringify(parcel.items.map(x => ({
                            id: itemRef(parcel.marketplace, x.id),
                            product_id: String(x.product_id || ''),
                            product_name: clean(x.product_name, 250),
                            quantity: Number(x.quantity || 0),
                            unit_price: Number(x.unit_price || 0),
                            line_total: Number(x.line_total || 0)
                        })))
                    ]
                );
                await client.query('COMMIT');
                return { existing: false, row: rows[0] };
            }

            const delhiveryOrderId = externalOrderNumber(parcel);
            const rows = await client.query(
                `INSERT INTO public.cerood_delhivery_shipments
                 (id,shipment_group_key,marketplace,order_id,seller_id,fulfilment_location_id,idempotency_key,
                  booking_state,delhivery_order_id,payment_mode,cod_amount,shipment_value,quantity,
                  weight_g,length_cm,width_cm,height_cm,package_description,hsn_code,order_item_refs,shipment_items)
                 VALUES($1,$2,$3,$4,$5,$6,$7,'creating',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb)
                 RETURNING *`,
                [
                    id,
                    groupKey,
                    parcel.marketplace,
                    parcel.orderId,
                    parcel.sellerId,
                    parcel.fulfilmentLocationId,
                    idempotencyKey,
                    delhiveryOrderId,
                    parcel.paymentMode,
                    parcel.codAmount,
                    parcel.shipmentValue,
                    parcel.quantity,
                    input.weightG,
                    input.lengthCm,
                    input.widthCm,
                    input.heightCm,
                    input.description,
                    input.hsnCode,
                    JSON.stringify(parcel.items.map(x => itemRef(parcel.marketplace, x.id))),
                    JSON.stringify(parcel.items.map(x => ({
                        id: itemRef(parcel.marketplace, x.id),
                        product_id: String(x.product_id || ''),
                        product_name: clean(x.product_name, 250),
                        quantity: Number(x.quantity || 0),
                        unit_price: Number(x.unit_price || 0),
                        line_total: Number(x.line_total || 0)
                    })))
                ]
            );
            await client.query('COMMIT');
            return { existing: false, row: rows[0] };
        } catch (error) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            if (client) client.release();
        }
    }

    async function setBookingFailure(id, state, message) {
        await query(
            `UPDATE public.cerood_delhivery_shipments
                SET booking_state=?,last_error=?,updated_at=NOW()
              WHERE id=?`,
            [state, clean(message, 1500), id]
        ).catch(() => {});
    }

    async function assertNoEkartShipment(parcel) {
        try {
            const rows = await query(
                `SELECT tracking_id,booking_state
                   FROM public.cerood_ekart_shipments
                  WHERE marketplace=? AND order_id=? AND seller_id=? AND fulfilment_location_id=?
                  ORDER BY updated_at DESC LIMIT 1`,
                [parcel.marketplace, parcel.orderId, parcel.sellerId, parcel.fulfilmentLocationId]
            );
            const row = rows[0];
            if (row?.tracking_id && !['cancelled', 'failed'].includes(String(row.booking_state || '').toLowerCase())) {
                throw httpError(409, 'This seller parcel already has an Ekart AWB. Delhivery duplicate booking was blocked.', 'COURIER_ALREADY_BOOKED');
            }
        } catch (error) {
            // If Ekart table is not installed yet, continue; otherwise preserve real errors.
            if (String(error?.code || '') === '42P01' || /cerood_ekart_shipments.*does not exist/i.test(String(error?.message || ''))) return;
            throw error;
        }
    }

    async function requireDestinationServiceable(parcel) {
        const result = await livePincodeServiceability(parcel.customer.pin);
        const p = result.parsed;
        const paymentOk = parcel.paymentMode === 'COD' ? p.cod_available : p.prepaid_available;
        if (!p.customer_delivery || !paymentOk) {
            throw httpError(
                409,
                `Delhivery ${parcel.paymentMode === 'COD' ? 'COD' : 'prepaid'} delivery is unavailable to customer pincode ${parcel.customer.pin}.`,
                'DELHIVERY_DESTINATION_UNAVAILABLE'
            );
        }
        return result;
    }

    function manifestPayload(parcel, pickup, warehouse, row, input) {
        const { clientName } = delhiveryConfig(true);
        const gst = dlText(pickup.gst_number, 30);
        if (!gst) {
            throw httpError(
                409,
                'Seller GST number is required for Delhivery manifestation. Complete the seller GST details before booking.',
                'SELLER_GST_REQUIRED'
            );
        }

        const sellerAddress = warehouseAddress(pickup);
        const productDescription = dlText(
            input.description || parcel.items.map(x => x.product_name).join(', '),
            250
        ) || 'E-commerce goods';
        const invoice = `INV-${row.delhivery_order_id}`.slice(0, 50);
        const today = new Date().toISOString().slice(0, 10);

        return {
            pickup_location: {
                name: warehouse,
                pin: String(pin6(pickup.pincode)),
                add: sellerAddress,
                phone: String(phone10(pickup.phone)),
                state: dlText(pickup.state, 100),
                city: dlText(pickup.city || pickup.district, 100),
                country: 'India'
            },
            shipments: [{
                name: parcel.customer.name,
                add: parcel.customer.address,
                pin: String(parcel.customer.pin),
                city: parcel.customer.city,
                state: parcel.customer.state,
                country: 'India',
                phone: String(parcel.customer.phone),
                order: row.delhivery_order_id,
                waybill: '',
                payment_mode: parcel.paymentMode,
                cod_amount: String(parcel.codAmount || 0),
                total_amount: String(parcel.shipmentValue),
                products_desc: productDescription,
                product_quantity: String(parcel.quantity),
                quantity: String(parcel.quantity),
                weight: String(input.weightG),
                shipment_length: String(input.lengthCm),
                shipment_width: String(input.widthCm),
                shipment_height: String(input.heightCm),
                order_date: today,
                seller_name: dlText(pickup.shop_name || pickup.owner_name || 'Cerood Seller', 180),
                seller_add: sellerAddress,
                seller_inv: invoice,
                seller_inv_date: today,
                seller_gst_tin: gst,
                hsn_code: input.hsnCode,
                invoice_reference: invoice,
                client: clientName,
                category_of_goods: 'E-commerce goods',
                commodity_value: String(parcel.shipmentValue),
                source: 'Cerood',
                return_name: dlText(pickup.shop_name || pickup.owner_name || 'Cerood Seller', 180),
                return_pin: String(pin6(pickup.pincode)),
                return_city: dlText(pickup.city || pickup.district, 100),
                return_phone: String(phone10(pickup.phone)),
                return_add: sellerAddress,
                return_state: dlText(pickup.state, 100),
                return_country: 'India'
            }]
        };
    }

    async function manifestShipment(parcel, pickup, warehouse, row, input) {
        const payload = manifestPayload(parcel, pickup, warehouse, row, input);
        // Delhivery's B2C manifestation endpoint expects the legacy body prefix
        // "format=json&data=" rather than a normal application/json object.
        const body = `format=json&data=${JSON.stringify(payload)}`;
        const response = await delhiveryRequest({
            method: 'POST',
            url: '/api/cmu/create.json',
            data: body,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 35_000,
            maxBodyLength: 1024 * 1024,
            maxContentLength: 4 * 1024 * 1024
        }, true);
        return response.data || {};
    }

    function extractManifestWaybill(data) {
        const packages = Array.isArray(data?.packages) ? data.packages : [];
        const successPkg = packages.find(p => /success/i.test(String(p?.status || ''))) || packages[0];
        const waybill = clean(successPkg?.waybill || data?.waybill || data?.awb, 140);
        const remarks = clean(successPkg?.remarks || data?.remark || data?.message || data?.error, 900);
        if (!waybill || data?.success === false || (successPkg && successPkg.status && !/success/i.test(String(successPkg.status)))) {
            throw httpError(409, remarks || 'Delhivery rejected shipment manifestation.', 'DELHIVERY_REJECTED');
        }
        return { waybill, remarks, package: successPkg || null };
    }

    function istParts(date = new Date()) {
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
            weekday: 'short'
        });
        const parts = Object.fromEntries(fmt.formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
        return parts;
    }

    function nextPickupSlot() {
        const configured = String(process.env.DELHIVERY_PICKUP_TIME || '14:00:00').trim();
        const validConfigured = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(configured) ? configured : '14:00:00';
        const now = istParts();
        let date = new Date();
        // If today's configured pickup time has already passed, use tomorrow.
        const [hh, mm] = validConfigured.split(':').map(Number);
        const currentMinutes = Number(now.hour) * 60 + Number(now.minute);
        if (currentMinutes >= hh * 60 + mm - 30) date = new Date(Date.now() + 24 * 60 * 60 * 1000);

        let parts = istParts(date);
        // Avoid Sunday by moving to Monday.
        if (parts.weekday === 'Sun') {
            date = new Date(date.getTime() + 24 * 60 * 60 * 1000);
            parts = istParts(date);
        }
        return {
            pickup_date: `${parts.year}-${parts.month}-${parts.day}`,
            pickup_time: validConfigured
        };
    }

    async function schedulePickupIfNeeded(shipmentRow, pickup) {
        if (String(process.env.DELHIVERY_AUTO_PICKUP_REQUEST || 'true').toLowerCase() === 'false') {
            return { skipped: true, reason: 'disabled' };
        }
        if (!shipmentRow?.warehouse_name) return { skipped: true, reason: 'warehouse_missing' };

        const slot = nextPickupSlot();
        const existing = await query(
            `SELECT * FROM public.cerood_delhivery_pickup_requests
              WHERE fulfilment_location_id=? AND pickup_date=?::date
              LIMIT 1`,
            [shipmentRow.fulfilment_location_id, slot.pickup_date]
        );
        if (existing.length && ['requested', 'auto_pickup', 'already_exists'].includes(String(existing[0].status || ''))) {
            return { existing: true, row: existing[0] };
        }

        const countRows = await query(
            `SELECT COUNT(*)::int AS cnt
               FROM public.cerood_delhivery_shipments
              WHERE fulfilment_location_id=?
                AND waybill IS NOT NULL
                AND cancelled_at IS NULL
                AND DATE(COALESCE(booked_at,created_at) AT TIME ZONE 'Asia/Kolkata')=?::date`,
            [shipmentRow.fulfilment_location_id, slot.pickup_date]
        );
        const expected = Math.max(1, Number(countRows[0]?.cnt || 1));
        const localId = crypto.randomUUID();

        await query(
            `INSERT INTO public.cerood_delhivery_pickup_requests
                (id,seller_id,fulfilment_location_id,warehouse_name,pickup_date,pickup_time,expected_package_count,status)
             VALUES(?,?,?,?,?::date,?::time,?,'creating')
             ON CONFLICT(fulfilment_location_id,pickup_date)
             DO UPDATE SET expected_package_count=GREATEST(public.cerood_delhivery_pickup_requests.expected_package_count,EXCLUDED.expected_package_count),updated_at=NOW()
             RETURNING *`,
            [
                localId,
                shipmentRow.seller_id,
                shipmentRow.fulfilment_location_id,
                shipmentRow.warehouse_name,
                slot.pickup_date,
                slot.pickup_time,
                expected
            ]
        );

        try {
            const response = await delhiveryRequest({
                method: 'POST',
                url: '/fm/request/new/',
                data: {
                    pickup_time: slot.pickup_time,
                    pickup_date: slot.pickup_date,
                    pickup_location: shipmentRow.warehouse_name,
                    expected_package_count: expected
                },
                headers: { 'Content-Type': 'application/json' },
                timeout: 25_000
            });
            const data = response.data || {};
            const pickupId = clean(data?.pickup_id || data?.pickup_request_id || data?.id, 160) || null;
            const rows = await query(
                `UPDATE public.cerood_delhivery_pickup_requests
                    SET status='requested',delhivery_pickup_id=?,response=?::jsonb,last_error=NULL,updated_at=NOW()
                  WHERE fulfilment_location_id=? AND pickup_date=?::date
                  RETURNING *`,
                [pickupId, JSON.stringify(data), shipmentRow.fulfilment_location_id, slot.pickup_date]
            );
            return { row: rows[0], response: data };
        } catch (error) {
            const message = safeDelhiveryMessage(error, 'Delhivery pickup request failed.');
            const autoPickup = /auto\s*pickup/i.test(message);
            const already = /already\s+exist/i.test(message) || /pickup request.*exist/i.test(message);
            if (autoPickup || already) {
                const rows = await query(
                    `UPDATE public.cerood_delhivery_pickup_requests
                        SET status=?,last_error=NULL,response=?::jsonb,updated_at=NOW()
                      WHERE fulfilment_location_id=? AND pickup_date=?::date
                      RETURNING *`,
                    [autoPickup ? 'auto_pickup' : 'already_exists', JSON.stringify({ message }), shipmentRow.fulfilment_location_id, slot.pickup_date]
                );
                return { row: rows[0], auto_pickup: autoPickup, already_exists: already };
            }
            await query(
                `UPDATE public.cerood_delhivery_pickup_requests
                    SET status='failed',last_error=?,updated_at=NOW()
                  WHERE fulfilment_location_id=? AND pickup_date=?::date`,
                [message, shipmentRow.fulfilment_location_id, slot.pickup_date]
            ).catch(() => {});
            throw error;
        }
    }

    async function bookShipmentForSeller({ sellerId, rawItemId, body, idempotencyKey }) {
        await ensureSchema();
        const ref = parseOrderItemRef(rawItemId);
        if (!ref) throw httpError(400, 'Invalid seller order item.', 'ORDER_ITEM');
        const input = bookingInput(body || {});
        const pickup = await loadSellerLocation(sellerId, input.locationId);

        // Pickup + destination are checked live before manifestation.
        const pickupSvc = await requirePickupServiceable(pickup, true);
        const parcel = await loadParcel(ref, sellerId, input.locationId);
        await assertNoEkartShipment(parcel);
        const destinationSvc = await requireDestinationServiceable(parcel);
        const warehouse = await ensureWarehouse(pickup);

        const key = clean(idempotencyKey, 220) || `seller:${sellerId}:delhivery:${shipmentGroupKey(parcel)}`.slice(0, 220);
        const reserved = await reserveBooking(parcel, input, key);
        let row = reserved.row;
        if (reserved.existing) {
            return {
                httpStatus: 200,
                already_created: true,
                message: 'This seller parcel already has a Delhivery shipment. Duplicate booking was blocked.',
                shipment: publicShipment(row)
            };
        }

        await query(
            `UPDATE public.cerood_delhivery_shipments
                SET warehouse_name=?,serviceability_response=?::jsonb,updated_at=NOW()
              WHERE id=?`,
            [warehouse, JSON.stringify({ pickup: pickupSvc, destination: destinationSvc.raw || destinationSvc.parsed }), row.id]
        );
        row.warehouse_name = warehouse;

        let manifestAttempted = false;
        try {
            manifestAttempted = true;
            const response = await manifestShipment(parcel, pickup, warehouse, row, input);
            const manifested = extractManifestWaybill(response);

            const rows = await query(
                `UPDATE public.cerood_delhivery_shipments
                    SET booking_state='booked',waybill=?,warehouse_name=?,delhivery_response=?::jsonb,
                        booked_at=NOW(),last_error=NULL,updated_at=NOW()
                  WHERE id=? RETURNING *`,
                [manifested.waybill, warehouse, JSON.stringify(response), row.id]
            );
            row = rows[0];

            let pickupResult = null;
            try {
                pickupResult = await schedulePickupIfNeeded(row, pickup);
                const pRow = pickupResult?.row;
                if (pRow) {
                    const linked = await query(
                        `UPDATE public.cerood_delhivery_shipments
                            SET booking_state=CASE WHEN booking_state='booked' THEN 'pickup_scheduled' ELSE booking_state END,
                                pickup_request_id=?,pickup_request_response=?::jsonb,pickup_requested_at=NOW(),updated_at=NOW()
                          WHERE id=? RETURNING *`,
                        [
                            pRow.delhivery_pickup_id || pRow.id,
                            JSON.stringify(pickupResult.response || pRow.response || { status: pRow.status }),
                            row.id
                        ]
                    );
                    row = linked[0] || row;
                }
            } catch (pickupError) {
                // AWB is valid even if pickup scheduling fails. Preserve the shipment
                // and surface a warning instead of booking another courier/AWB.
                await query(
                    `UPDATE public.cerood_delhivery_shipments
                        SET last_error=?,updated_at=NOW()
                      WHERE id=?`,
                    [`AWB created, but pickup request failed: ${safeDelhiveryMessage(pickupError, 'pickup request failed')}`, row.id]
                ).catch(() => {});
                return {
                    httpStatus: 201,
                    warning: true,
                    message: `Delhivery AWB ${manifested.waybill} created, but pickup request needs attention. Do not create another AWB.`,
                    shipment: publicShipment(row)
                };
            }

            return {
                httpStatus: 201,
                message: `Delhivery AWB ${manifested.waybill} created and pickup arranged for this seller location.`,
                shipment: publicShipment(row)
            };
        } catch (error) {
            const uncertain = manifestAttempted && (
                error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
                Number(error.response?.status || 0) >= 500 ||
                error.code === 'DELHIVERY_UNAVAILABLE'
            );
            await setBookingFailure(row.id, uncertain ? 'booking_unknown' : 'failed', error.message);
            throw error;
        }
    }

    // ------------------------------------------------------------
    // Tracking + seller-order attachment.
    // ------------------------------------------------------------
    async function attachShipments(orders, sellerId) {
        await ensureSchema();
        const list = Array.isArray(orders) ? orders : [];
        if (!list.length) return list;
        const rows = await query(
            `SELECT * FROM public.cerood_delhivery_shipments
              WHERE seller_id=?
              ORDER BY updated_at DESC
              LIMIT 500`,
            [sellerId]
        );
        const byOrder = new Map();
        for (const row of rows) {
            const key = `${row.marketplace}|${row.order_id}`;
            if (!byOrder.has(key)) byOrder.set(key, []);
            byOrder.get(key).push(row);
        }
        return list.map(order => {
            const marketplace = String(order.marketplace || 'renewed');
            const candidates = byOrder.get(`${marketplace}|${String(order.order_id)}`) || [];
            const loc = String(order.fulfilment_location_id || '');
            const row = (loc && candidates.find(x => String(x.fulfilment_location_id) === loc)) || candidates[0];
            return row ? { ...order, delhivery_shipment: publicShipment(row) } : order;
        });
    }

    async function resolveItemForSeller(rawItemId, sellerId) {
        await ensureSchema();
        const ref = parseOrderItemRef(rawItemId);
        if (!ref) throw httpError(400, 'Invalid seller order item.', 'ORDER_ITEM');
        const cfg = MARKETPLACES[ref.marketplace];
        const rows = await query(
            `SELECT id,order_id,seller_id,fulfilment_location_id,COALESCE(seller_order_status,'new') AS seller_order_status
               FROM public.${cfg.itemTable}
              WHERE id=? AND seller_id=? LIMIT 1`,
            [ref.id, sellerId]
        );
        if (!rows.length) throw httpError(404, 'Seller order item was not found.', 'ORDER_NOT_FOUND');
        return { ref, item: rows[0] };
    }

    async function findShipmentForItem(rawItemId, sellerId) {
        const { ref, item } = await resolveItemForSeller(rawItemId, sellerId);
        const params = [ref.marketplace, String(item.order_id), sellerId];
        let sql = `SELECT * FROM public.cerood_delhivery_shipments
                    WHERE marketplace=? AND order_id=? AND seller_id=?`;
        if (item.fulfilment_location_id) {
            sql += ` AND fulfilment_location_id=?`;
            params.push(item.fulfilment_location_id);
        }
        sql += ` ORDER BY updated_at DESC LIMIT 1`;
        const rows = await query(sql, params);
        return { ref, item, shipment: rows[0] || null };
    }

    async function assertBookedForItem(rawItemId, sellerId) {
        const found = await findShipmentForItem(rawItemId, sellerId);
        const row = found.shipment;
        if (!row || !row.waybill || ['cancelled', 'booking_unknown', 'failed'].includes(String(row.booking_state || '').toLowerCase())) {
            throw httpError(409, 'Create a valid courier AWB/pickup before marking this seller item as shipped.', 'AWB_REQUIRED');
        }
        return publicShipment(row);
    }

    function parseTrackingStatus(data) {
        const shipment = Array.isArray(data?.ShipmentData)
            ? data.ShipmentData[0]?.Shipment
            : data?.Shipment || data;
        const statusObj = shipment?.Status || {};
        const status = clean(statusObj.Status || shipment?.Status || data?.status || 'booked', 160);
        const lower = status.toLowerCase();
        let state = 'booked';
        if (/delivered/.test(lower)) state = 'delivered';
        else if (/out for delivery|dispatched/.test(lower)) state = 'out_for_delivery';
        else if (/in transit|picked|pending|manifested|bag|hub|depart|arriv/.test(lower)) state = 'in_transit';
        else if (/rto|return/.test(lower)) state = 'rto';
        else if (/cancel/.test(lower)) state = 'cancelled';
        return { status, state, shipment };
    }

    async function refreshShipmentRow(row) {
        if (!row?.waybill) throw httpError(409, 'This Delhivery shipment has no AWB yet.', 'NO_AWB');
        const response = await delhiveryRequest({
            method: 'GET',
            url: '/api/v1/packages/json/',
            params: { waybill: row.waybill, ref_ids: '' },
            timeout: 20_000
        });
        const data = response.data || {};
        const parsed = parseTrackingStatus(data);
        const rows = await query(
            `UPDATE public.cerood_delhivery_shipments
                SET last_tracking=?::jsonb,last_tracking_status=?,last_tracking_at=NOW(),updated_at=NOW(),
                    booking_state=CASE WHEN cancelled_at IS NOT NULL THEN booking_state ELSE ? END
              WHERE id=? RETURNING *`,
            [JSON.stringify(data), parsed.status || null, parsed.state, row.id]
        );
        return rows[0] || row;
    }

    // ------------------------------------------------------------
    // Seller routes.
    // ------------------------------------------------------------
    app.get('/api/sellers/delhivery/status', requireSellerAuth, async (req, res) => {
        try {
            await ensureSchema();
            return res.json({
                success: true,
                configured: Boolean(String(process.env.DELHIVERY_API_TOKEN || '').trim()),
                client_name_configured: Boolean(clean(process.env.DELHIVERY_CLIENT_NAME, 180)),
                environment: DELHIVERY_BASE_URL.includes('staging-') ? 'staging' : 'production',
                cache_hours: TTL_HOURS,
                auto_pickup_request: String(process.env.DELHIVERY_AUTO_PICKUP_REQUEST || 'true').toLowerCase() !== 'false'
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
                        delhivery_serviceability_checked_at,delhivery_serviceability_error,
                        delhivery_warehouse_name,delhivery_warehouse_registered_at,delhivery_warehouse_error
                   FROM public.cerood_seller_locations
                  WHERE seller_id=? AND is_active=true
                  ORDER BY is_default DESC,created_at ASC`,
                [req.seller.id]
            );
            return res.json({
                success: true,
                configured: Boolean(String(process.env.DELHIVERY_API_TOKEN || '').trim()),
                client_name_configured: Boolean(clean(process.env.DELHIVERY_CLIENT_NAME, 180)),
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
            const serviceability = await refreshPickupServiceability(location, force);
            return res.json({
                success: true,
                cached: !force && isFresh(location),
                serviceability,
                message: serviceability.seller_pickup
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

    app.post('/api/sellers/locations/:id/delhivery-register', requireSellerAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            await ensureSchema();
            const location = await loadSellerLocation(req.seller.id, req.params.id);
            await requirePickupServiceable(location, true);
            const name = await ensureWarehouse(location);
            return res.json({
                success: true,
                warehouse_name: name,
                message: `Delhivery pickup warehouse ${name} is registered for this seller location.`
            });
        } catch (error) {
            console.error('Delhivery warehouse registration:', error.code || error.message);
            return res.status(error.status || 502).json({
                success: false,
                code: error.code || undefined,
                message: error.message || 'Unable to register Delhivery pickup warehouse.'
            });
        }
    });

    app.post('/api/seller/orders/:orderItemId/delhivery-shipment', requireSellerAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const result = await bookShipmentForSeller({
                sellerId: req.seller.id,
                rawItemId: req.params.orderItemId,
                body: req.body || {},
                idempotencyKey: req.get('Idempotency-Key')
            });
            return res.status(result.httpStatus || 200).json({ success: true, ...result });
        } catch (error) {
            const message = error.status ? error.message : safeDelhiveryMessage(error, 'Delhivery shipment creation failed.');
            console.error('Delhivery shipment booking:', error.code || error.message);
            return res.status(error.status || 502).json({ success: false, code: error.code || undefined, message });
        }
    });

    app.post('/api/seller/orders/:orderItemId/delhivery-shipment/refresh', requireSellerAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const found = await findShipmentForItem(req.params.orderItemId, req.seller.id);
            if (!found.shipment) throw httpError(404, 'Delhivery shipment was not found.', 'SHIPMENT_NOT_FOUND');
            const row = await refreshShipmentRow(found.shipment);
            return res.json({ success: true, shipment: publicShipment(row) });
        } catch (error) {
            return res.status(error.status || 502).json({ success: false, code: error.code || undefined, message: error.message || 'Unable to refresh Delhivery tracking.' });
        }
    });

    app.get('/api/seller/orders/:orderItemId/delhivery-label', requireSellerAuth, async (req, res) => {
        try {
            const found = await findShipmentForItem(req.params.orderItemId, req.seller.id);
            if (!found.shipment?.waybill) throw httpError(404, 'Delhivery AWB was not found.', 'NO_AWB');
            const response = await delhiveryRequest({
                method: 'GET',
                url: '/api/p/packing_slip',
                params: { wbns: found.shipment.waybill, pdf: 'True' },
                responseType: 'arraybuffer',
                timeout: 30_000,
                maxContentLength: 10 * 1024 * 1024
            });
            const type = String(response.headers?.['content-type'] || 'application/octet-stream');
            res.set('Cache-Control', 'private, no-store');
            res.set('Content-Type', type);
            if (/pdf/i.test(type)) {
                res.set('Content-Disposition', `attachment; filename="delhivery-${found.shipment.waybill}.pdf"`);
            }
            return res.send(Buffer.from(response.data));
        } catch (error) {
            if (res.headersSent) return;
            return res.status(error.status || 502).json({ success: false, message: error.message || 'Unable to download Delhivery label.' });
        }
    });

    // ------------------------------------------------------------
    // Admin read/refresh routes. Customer delivery state stays separate.
    // ------------------------------------------------------------
    app.get('/api/admin/delhivery/shipments', requireAdminAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            await ensureSchema();
            const rows = await query(
                `SELECT d.*,s.shop_name,s.owner_name,l.location_name,l.pincode AS pickup_pincode
                   FROM public.cerood_delhivery_shipments d
                   JOIN public.cerood_sellers s ON s.id=d.seller_id
                   JOIN public.cerood_seller_locations l ON l.id=d.fulfilment_location_id
                  ORDER BY d.created_at DESC
                  LIMIT 500`
            );
            return res.json({
                success: true,
                shipments: rows.map(row => ({
                    ...publicShipment(row),
                    shop_name: row.shop_name,
                    owner_name: row.owner_name,
                    location_name: row.location_name,
                    pickup_pincode: row.pickup_pincode
                }))
            });
        } catch (error) {
            console.error('Admin Delhivery list:', error.message);
            return res.status(500).json({ success: false, message: 'Unable to load Delhivery shipments.' });
        }
    });

    app.post('/api/admin/delhivery/shipments/:id/refresh', requireAdminAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            await ensureSchema();
            if (!uuid(req.params.id)) throw httpError(400, 'Invalid shipment.', 'SHIPMENT_ID');
            const rows = await query(`SELECT * FROM public.cerood_delhivery_shipments WHERE id=? LIMIT 1`, [req.params.id]);
            if (!rows.length) throw httpError(404, 'Delhivery shipment was not found.', 'SHIPMENT_NOT_FOUND');
            const row = await refreshShipmentRow(rows[0]);
            return res.json({ success: true, shipment: publicShipment(row) });
        } catch (error) {
            return res.status(error.status || 502).json({ success: false, message: error.message || 'Unable to refresh Delhivery shipment.' });
        }
    });

    return {
        ensureSchema,
        liveServiceability,
        refreshPickupServiceability,
        bookShipmentForSeller,
        attachShipments,
        assertBookedForItem,
        findShipmentForItem,
        publicShipment
    };
};
