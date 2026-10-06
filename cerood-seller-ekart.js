'use strict';

// ============================================================
// CEROOD × EKART — MULTI-VENDOR SHIPPING
//
// One physical shipment is created per:
//   marketplace + customer order + seller + pickup location.
//
// This keeps seller fulfilment separate from CEROOD admin/customer
// delivery status. Ekart tracking is stored independently and never
// auto-overwrites the customer-facing delivery status.
//
// Required private environment variables:
//   EKART_CLIENT_ID
//   EKART_USERNAME
//   EKART_PASSWORD
//
// Optional:
//   EKART_BASE_URL=https://app.elite.ekartlogistics.in
//   EKART_DEFAULT_SERVICE=SURFACE   (or EXPRESS)
//   EKART_SKIP_SERVICEABILITY_CHECK=false
// ============================================================

const axios = require('axios');
const crypto = require('crypto');

module.exports = function registerCeroodSellerEkart(
    app,
    db,
    requireSellerAuth,
    requireAdminAuth
) {
    const EKART_BASE_URL = String(
        process.env.EKART_BASE_URL || 'https://app.elite.ekartlogistics.in'
    ).trim().replace(/\/$/, '');

    const MARKETPLACES = Object.freeze({
        renewed: {
            itemTable: 'renewed_order_items',
            orderTable: 'renewed_orders',
            lineColumn: 'line_total',
            productTable: 'renewed_products'
        },
        cosmetics: {
            itemTable: 'cosmetics_order_items',
            orderTable: 'cosmetics_orders',
            lineColumn: 'total_price',
            productTable: 'cosmetics_products'
        },
        clothing: {
            itemTable: 'clothing_order_items',
            orderTable: 'clothing_orders',
            lineColumn: 'total_price',
            productTable: 'clothing_products'
        },
        shop: {
            itemTable: 'cerood_shop_order_items',
            orderTable: 'cerood_shop_orders',
            lineColumn: 'line_total',
            productTable: 'cerood_shop_products'
        }
    });

    const query = (sql, params = []) => new Promise((resolve, reject) => {
        db.query(sql, params, (error, rows) => {
            if (error) return reject(error);
            resolve(rows || []);
        });
    });

    const clean = (value, max = 250) => String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);

    const digits = value => String(value ?? '').replace(/\D/g, '');
    const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(String(value || '').trim());
    const validPhone = value => /^[6-9]\d{9}$/.test(digits(value).replace(/^91(?=[6-9]\d{9}$)/, ''));
    const phone10 = value => digits(value).replace(/^91(?=[6-9]\d{9}$)/, '').slice(-10);
    const pin6 = value => digits(value).slice(0, 6);
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

    // ------------------------------------------------------------
    // Database schema. Existing order tables are only extended with
    // shipping/fulfilment metadata; no Home Services table is touched.
    // ------------------------------------------------------------
    let schemaPromise;
    function ensureSchema() {
        if (!schemaPromise) {
            schemaPromise = (async () => {
                const statements = [
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS ekart_alias VARCHAR(120)`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS ekart_registered_at TIMESTAMPTZ`,
                    `ALTER TABLE public.cerood_seller_locations ADD COLUMN IF NOT EXISTS ekart_registration_error TEXT`,

                    `ALTER TABLE public.cosmetics_order_items ADD COLUMN IF NOT EXISTS fulfilment_location_id UUID`,
                    `ALTER TABLE public.clothing_order_items ADD COLUMN IF NOT EXISTS fulfilment_location_id UUID`,
                    `ALTER TABLE public.cerood_shop_order_items ADD COLUMN IF NOT EXISTS fulfilment_location_id UUID`,

                    `ALTER TABLE public.cerood_shop_order_items ADD COLUMN IF NOT EXISTS seller_order_status VARCHAR(30)`,
                    `ALTER TABLE public.cerood_shop_order_items ADD COLUMN IF NOT EXISTS seller_accepted_at TIMESTAMPTZ`,
                    `ALTER TABLE public.cerood_shop_order_items ADD COLUMN IF NOT EXISTS seller_rejected_at TIMESTAMPTZ`,
                    `ALTER TABLE public.cerood_shop_order_items ADD COLUMN IF NOT EXISTS seller_packed_at TIMESTAMPTZ`,
                    `ALTER TABLE public.cerood_shop_order_items ADD COLUMN IF NOT EXISTS seller_shipped_at TIMESTAMPTZ`,
                    `ALTER TABLE public.cerood_shop_order_items ADD COLUMN IF NOT EXISTS seller_order_note TEXT`,

                    `CREATE TABLE IF NOT EXISTS public.cerood_ekart_shipments (
                        id UUID PRIMARY KEY,
                        shipment_group_key VARCHAR(420) NOT NULL UNIQUE,
                        marketplace VARCHAR(30) NOT NULL,
                        order_id TEXT NOT NULL,
                        seller_id UUID NOT NULL REFERENCES public.cerood_sellers(id),
                        fulfilment_location_id UUID NOT NULL REFERENCES public.cerood_seller_locations(id),
                        idempotency_key VARCHAR(220),
                        booking_state VARCHAR(40) NOT NULL DEFAULT 'creating',
                        tracking_id VARCHAR(140),
                        vendor VARCHAR(140),
                        ekart_order_number VARCHAR(180) NOT NULL,
                        invoice_number VARCHAR(180) NOT NULL,
                        pickup_alias VARCHAR(120),
                        service VARCHAR(20) NOT NULL DEFAULT 'SURFACE',
                        payment_mode VARCHAR(20) NOT NULL,
                        cod_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
                        shipment_value NUMERIC(14,2) NOT NULL,
                        quantity INTEGER NOT NULL,
                        weight_g INTEGER NOT NULL,
                        length_cm INTEGER NOT NULL,
                        width_cm INTEGER NOT NULL,
                        height_cm INTEGER NOT NULL,
                        package_description VARCHAR(500),
                        order_item_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
                        shipment_items JSONB NOT NULL DEFAULT '[]'::jsonb,
                        serviceability_response JSONB,
                        ekart_response JSONB,
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
                    `CREATE INDEX IF NOT EXISTS cerood_ekart_shipments_seller_order_idx
                        ON public.cerood_ekart_shipments(seller_id, marketplace, order_id, updated_at DESC)`,
                    `CREATE INDEX IF NOT EXISTS cerood_ekart_shipments_tracking_idx
                        ON public.cerood_ekart_shipments(tracking_id) WHERE tracking_id IS NOT NULL`
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
    // Ekart auth/token cache.
    // ------------------------------------------------------------
    let tokenCache = null;

    function ekartConfig() {
        const clientId = clean(process.env.EKART_CLIENT_ID, 180);
        const username = clean(process.env.EKART_USERNAME, 320);
        const password = String(process.env.EKART_PASSWORD || '');
        if (!clientId || !username || !password) {
            throw httpError(503, 'Ekart API credentials are not configured on the server.', 'EKART_CONFIG');
        }
        return { clientId, username, password };
    }

    async function ekartToken(force = false) {
        if (!force && tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
            return tokenCache;
        }

        const cfg = ekartConfig();
        const url = `${EKART_BASE_URL}/integrations/v2/auth/token/${encodeURIComponent(cfg.clientId)}`;
        let response;
        try {
            response = await axios.post(url, {
                username: cfg.username,
                password: cfg.password
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15_000,
                maxBodyLength: 64 * 1024
            });
        } catch (error) {
            const status = Number(error.response?.status || 0);
            if (status === 401 || status === 403) {
                throw httpError(503, 'Ekart authentication was rejected. Check the server API credentials.', 'EKART_AUTH');
            }
            throw httpError(503, 'Ekart authentication is temporarily unavailable.', 'EKART_AUTH_UNAVAILABLE');
        }

        const access = clean(response.data?.access_token, 4096);
        const type = clean(response.data?.token_type || 'Bearer', 30);
        const expires = Math.max(60, Number(response.data?.expires_in || 3600));
        if (!access) throw httpError(503, 'Ekart authentication returned no access token.', 'EKART_AUTH_EMPTY');

        tokenCache = {
            token: access,
            type,
            expiresAt: Date.now() + expires * 1000
        };
        return tokenCache;
    }

    async function ekartAuthedRequest(config, retry401 = true) {
        const auth = await ekartToken(false);
        try {
            return await axios.request({
                ...config,
                url: `${EKART_BASE_URL}${config.url}`,
                headers: {
                    ...(config.headers || {}),
                    Authorization: `${auth.type} ${auth.token}`
                }
            });
        } catch (error) {
            if (retry401 && Number(error.response?.status) === 401) {
                tokenCache = null;
                await ekartToken(true);
                return ekartAuthedRequest(config, false);
            }
            throw error;
        }
    }

    function safeEkartMessage(error, fallback) {
        const data = error?.response?.data;
        const candidate = clean(
            data?.message || data?.description || data?.remark || error?.message || fallback,
            500
        );
        return candidate || fallback;
    }

    // ------------------------------------------------------------
    // Item/order parsing.
    // ------------------------------------------------------------
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

    function customerLocation(order) {
        const a = parseJsonObject(order.delivery_address);
        const name = clean(a.full_name || a.name || order.customer_name, 140);
        const phone = phone10(a.phone || order.customer_phone);
        const pin = pin6(a.pincode || a.pin || a.pin_code || a.postal_code);
        const city = clean(a.city || a.village || a.town || a.district, 120);
        const state = clean(a.state, 120);
        const address = clean([
            a.house,
            a.address_line1,
            a.street,
            a.area,
            a.village && a.village !== city ? a.village : '',
            a.address_line2,
            a.landmark,
            a.district
        ].filter(Boolean).join(', '), 900);

        if (!name || !validPhone(phone) || !/^[1-9]\d{5}$/.test(pin) || !address || !state) {
            throw httpError(409, 'Customer delivery address is incomplete for Ekart shipment booking.', 'CUSTOMER_ADDRESS');
        }

        return {
            name,
            phone: Number(phone),
            pin: Number(pin),
            address,
            city: city || clean(a.district, 120),
            state,
            country: 'India'
        };
    }

    async function loadSellerLocation(sellerId, locationId) {
        if (!uuid(locationId)) throw httpError(400, 'Choose a valid seller pickup location.', 'PICKUP_LOCATION');
        const rows = await query(
            `SELECT l.id,l.seller_id,l.location_name,l.address_line1,l.address_line2,l.city,l.district,l.state,l.pincode,
                    l.is_active,l.is_default,l.ekart_alias,l.ekart_registered_at,l.ekart_registration_error,
                    s.owner_name,s.shop_name,s.phone,s.email,s.gst_number
               FROM public.cerood_seller_locations l
               JOIN public.cerood_sellers s ON s.id=l.seller_id
              WHERE l.id=? AND l.seller_id=? AND l.is_active=true AND s.status='approved'
              LIMIT 1`,
            [locationId, sellerId]
        );
        if (!rows.length) throw httpError(404, 'Seller pickup location was not found.', 'PICKUP_NOT_FOUND');

        const row = rows[0];
        const phone = phone10(row.phone);
        const pincode = pin6(row.pincode);
        if (!validPhone(phone) || !/^[1-9]\d{5}$/.test(pincode) || !clean(row.address_line1, 400) || !clean(row.state, 120)) {
            throw httpError(409, 'Complete the pickup address (address, state, pincode and seller phone) before booking Ekart.', 'PICKUP_INCOMPLETE');
        }
        return row;
    }

    function deterministicAlias(location) {
        const seller = String(location.seller_id || '').replace(/-/g, '').slice(0, 10).toUpperCase();
        const loc = String(location.id || '').replace(/-/g, '').slice(0, 10).toUpperCase();
        return `CEROOD_${seller}_${loc}`.slice(0, 120);
    }

    function pickupPayload(location, alias) {
        return {
            alias,
            phone: Number(phone10(location.phone)),
            address_line1: clean(location.address_line1, 500),
            address_line2: clean(location.address_line2, 500) || undefined,
            pincode: Number(pin6(location.pincode)),
            city: clean(location.city || location.district, 120) || undefined,
            state: clean(location.state, 120),
            country: 'India'
        };
    }

    function pickupLocationV1(location, alias) {
        return {
            name: alias,
            phone: Number(phone10(location.phone)),
            address: clean([
                location.address_line1,
                location.address_line2,
                location.city,
                location.district,
                location.state
            ].filter(Boolean).join(', '), 900),
            city: clean(location.city || location.district, 120) || undefined,
            state: clean(location.state, 120),
            country: 'India',
            pin: Number(pin6(location.pincode))
        };
    }

    async function ensurePickupAlias(location) {
        if (clean(location.ekart_alias, 120)) return clean(location.ekart_alias, 120);

        const alias = deterministicAlias(location);
        try {
            const existing = await ekartAuthedRequest({
                method: 'GET',
                url: '/api/v2/addresses',
                timeout: 15_000,
                maxContentLength: 2 * 1024 * 1024
            });
            const list = Array.isArray(existing.data) ? existing.data : [];
            if (list.some(row => String(row?.alias || '').toLowerCase() === alias.toLowerCase())) {
                await query(
                    `UPDATE public.cerood_seller_locations
                        SET ekart_alias=?,ekart_registered_at=NOW(),ekart_registration_error=NULL,updated_at=NOW()
                      WHERE id=? AND seller_id=?`,
                    [alias, location.id, location.seller_id]
                );
                return alias;
            }
        } catch (error) {
            // A failed read should not stop a direct idempotent registration attempt.
            if ([401, 403].includes(Number(error.response?.status))) throw error;
        }

        try {
            const response = await ekartAuthedRequest({
                method: 'POST',
                url: '/api/v2/address',
                data: pickupPayload(location, alias),
                headers: { 'Content-Type': 'application/json' },
                timeout: 20_000,
                maxBodyLength: 64 * 1024
            });

            if (response.data?.status === false) {
                throw httpError(409, clean(response.data?.remark || 'Ekart rejected this pickup address.', 500), 'EKART_ADDRESS_REJECTED');
            }

            const confirmedAlias = clean(response.data?.alias || alias, 120);
            await query(
                `UPDATE public.cerood_seller_locations
                    SET ekart_alias=?,ekart_registered_at=NOW(),ekart_registration_error=NULL,updated_at=NOW()
                  WHERE id=? AND seller_id=?`,
                [confirmedAlias, location.id, location.seller_id]
            );
            return confirmedAlias;
        } catch (error) {
            const message = safeEkartMessage(error, 'Ekart could not register this pickup address.');
            await query(
                `UPDATE public.cerood_seller_locations
                    SET ekart_registration_error=?,updated_at=NOW()
                  WHERE id=? AND seller_id=?`,
                [message, location.id, location.seller_id]
            ).catch(() => {});
            if (error.status) throw error;
            throw httpError(409, `Ekart pickup address registration failed: ${message}`, 'EKART_ADDRESS');
        }
    }

    // ------------------------------------------------------------
    // Load authoritative order + all items belonging to this seller
    // and selected pickup location. Browser totals/customer fields are
    // never used.
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
            throw httpError(409, 'Mark the seller item as packed before arranging Ekart pickup.', 'NOT_PACKED');
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
            throw httpError(409, `Pack all ${groupItems.length} seller item(s) assigned to this pickup before creating one Ekart shipment.`, 'GROUP_NOT_READY');
        }

        // Lock previously unassigned items to the selected seller location. This
        // prevents the same item being booked again from a second warehouse.
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

        // Order-level adjustment = delivery fee - discounts/other adjustments.
        // Calculate it from all original lines (including rejected lines) so a
        // rejected product amount is never accidentally reassigned to another seller.
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

        const paymentMode = String(requested.payment_method || '').toLowerCase() === 'cod' ? 'COD' : 'Prepaid';
        const codAmount = paymentMode === 'COD' ? shipmentValue : 0;
        if (codAmount > 49999) {
            throw httpError(409, 'Ekart COD amount limit is ₹49,999 for this shipment. Split or resolve the order before booking.', 'COD_LIMIT');
        }

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
        return `CE-${m}-${order}-${seller}-${loc}`.slice(0, 180);
    }

    function publicShipment(row) {
        if (!row) return null;
        const tracking = clean(row.tracking_id, 140) || null;
        return {
            id: row.id,
            marketplace: row.marketplace,
            order_id: row.order_id,
            seller_id: row.seller_id,
            fulfilment_location_id: row.fulfilment_location_id,
            booking_state: row.booking_state,
            awb: tracking,
            tracking_id: tracking,
            status: row.last_tracking_status || row.booking_state,
            vendor: row.vendor || null,
            pickup_alias: row.pickup_alias || null,
            service: row.service || null,
            payment_mode: row.payment_mode || null,
            cod_amount: Number(row.cod_amount || 0),
            shipment_value: Number(row.shipment_value || 0),
            weight_g: Number(row.weight_g || 0),
            length_cm: Number(row.length_cm || 0),
            width_cm: Number(row.width_cm || 0),
            height_cm: Number(row.height_cm || 0),
            last_tracking_status: row.last_tracking_status || null,
            booked_at: row.booked_at || null,
            last_tracking_at: row.last_tracking_at || null,
            cancelled_at: row.cancelled_at || null,
            tracking_url: tracking
                ? `${EKART_BASE_URL}/track/${encodeURIComponent(tracking)}`
                : null
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
            const currentRows = await client.query(
                `SELECT * FROM public.cerood_ekart_shipments WHERE shipment_group_key=$1 FOR UPDATE`,
                [groupKey]
            );
            const current = currentRows[0];

            if (current) {
                if (current.tracking_id || ['booked', 'pickup_scheduled', 'in_transit', 'delivered'].includes(String(current.booking_state || '').toLowerCase())) {
                    await client.query('COMMIT');
                    return { existing: true, row: current };
                }
                if (String(current.booking_state) === 'booking_unknown') {
                    await client.query('COMMIT');
                    throw httpError(409, 'A previous Ekart booking attempt has an unknown result. Verify it in Ekart before retrying to avoid a duplicate AWB.', 'BOOKING_UNKNOWN');
                }
                if (String(current.booking_state) === 'creating' && new Date(current.updated_at || current.booking_started_at).getTime() > Date.now() - 10 * 60_000) {
                    await client.query('COMMIT');
                    throw httpError(409, 'Ekart shipment creation is already in progress for this seller parcel.', 'BOOKING_IN_PROGRESS');
                }

                const rows = await client.query(
                    `UPDATE public.cerood_ekart_shipments
                        SET idempotency_key=$2,booking_state='creating',tracking_id=NULL,vendor=NULL,
                            fulfilment_location_id=$3,service=$4,payment_mode=$5,cod_amount=$6,shipment_value=$7,
                            quantity=$8,weight_g=$9,length_cm=$10,width_cm=$11,height_cm=$12,
                            package_description=$13,order_item_refs=$14::jsonb,shipment_items=$15::jsonb,
                            last_error=NULL,booking_started_at=NOW(),updated_at=NOW()
                      WHERE id=$1 RETURNING *`,
                    [
                        current.id,
                        idempotencyKey,
                        parcel.fulfilmentLocationId,
                        input.service,
                        parcel.paymentMode,
                        parcel.codAmount,
                        parcel.shipmentValue,
                        parcel.quantity,
                        input.weightG,
                        input.lengthCm,
                        input.widthCm,
                        input.heightCm,
                        input.description,
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

            const orderNumber = externalOrderNumber(parcel);
            const invoiceNumber = `INV-${orderNumber}`.slice(0, 180);
            const rows = await client.query(
                `INSERT INTO public.cerood_ekart_shipments
                 (id,shipment_group_key,marketplace,order_id,seller_id,fulfilment_location_id,idempotency_key,
                  booking_state,ekart_order_number,invoice_number,service,payment_mode,cod_amount,shipment_value,
                  quantity,weight_g,length_cm,width_cm,height_cm,package_description,order_item_refs,shipment_items)
                 VALUES($1,$2,$3,$4,$5,$6,$7,'creating',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb)
                 RETURNING *`,
                [
                    id,
                    groupKey,
                    parcel.marketplace,
                    parcel.orderId,
                    parcel.sellerId,
                    parcel.fulfilmentLocationId,
                    idempotencyKey,
                    orderNumber,
                    invoiceNumber,
                    input.service,
                    parcel.paymentMode,
                    parcel.codAmount,
                    parcel.shipmentValue,
                    parcel.quantity,
                    input.weightG,
                    input.lengthCm,
                    input.widthCm,
                    input.heightCm,
                    input.description,
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
            `UPDATE public.cerood_ekart_shipments
                SET booking_state=?,last_error=?,updated_at=NOW()
              WHERE id=?`,
            [state, clean(message, 1500), id]
        ).catch(() => {});
    }

    async function serviceabilityCheck(parcel, pickup, input) {
        if (process.env.EKART_SKIP_SERVICEABILITY_CHECK === 'true') return [];
        const payload = {
            pickupPincode: pin6(pickup.pincode),
            dropPincode: String(parcel.customer.pin),
            length: String(input.lengthCm),
            width: String(input.widthCm),
            height: String(input.heightCm),
            weight: String(input.weightG),
            paymentType: parcel.paymentMode,
            serviceType: input.service,
            invoiceAmount: String(parcel.shipmentValue)
        };
        if (parcel.paymentMode === 'COD') payload.codAmount = String(parcel.codAmount);

        const response = await ekartAuthedRequest({
            method: 'POST',
            url: '/data/v3/serviceability',
            data: payload,
            headers: { 'Content-Type': 'application/json' },
            timeout: 20_000,
            maxBodyLength: 64 * 1024,
            maxContentLength: 2 * 1024 * 1024
        });
        const result = Array.isArray(response.data) ? response.data : [];
        if (!result.length) {
            throw httpError(409, 'Ekart has no available courier route for this seller pickup → customer pincode and parcel.', 'NOT_SERVICEABLE');
        }
        return result;
    }

    function shipmentRequest(parcel, pickup, alias, row, input) {
        const description = clean(input.description || parcel.items.map(x => x.product_name).join(', '), 500) || 'E-commerce goods';
        const pickupV1 = pickupLocationV1(pickup, alias);
        const total = parcel.shipmentValue;
        const today = new Date().toISOString().slice(0, 10);

        return {
            seller_name: clean(pickup.shop_name || pickup.owner_name || 'Cerood Seller', 180),
            seller_address: pickupV1.address,
            seller_gst_tin: clean(pickup.gst_number, 30),
            seller_gst_amount: 0,
            consignee_gst_amount: 0,
            integrated_gst_amount: 0,
            order_number: row.ekart_order_number,
            invoice_number: row.invoice_number,
            invoice_date: today,
            consignee_name: parcel.customer.name,
            consignee_alternate_phone: String(parcel.customer.phone),
            payment_mode: parcel.paymentMode,
            category_of_goods: 'E-commerce goods',
            products_desc: description,
            total_amount: total,
            cod_amount: parcel.codAmount,
            tax_value: 0,
            taxable_amount: total,
            commodity_value: String(total),
            return_reason: '',
            quantity: parcel.quantity,
            weight: input.weightG,
            length: input.lengthCm,
            height: input.heightCm,
            width: input.widthCm,
            drop_location: parcel.customer,
            pickup_location: pickupV1,
            return_location: pickupV1,
            service: input.service
        };
    }

    async function createShipment(parcel, pickup, alias, row, input) {
        const payload = shipmentRequest(parcel, pickup, alias, row, input);
        const response = await ekartAuthedRequest({
            method: 'PUT',
            url: '/api/v1/package/create',
            data: payload,
            headers: { 'Content-Type': 'application/json' },
            timeout: 35_000,
            maxBodyLength: 512 * 1024,
            maxContentLength: 2 * 1024 * 1024
        });
        return response.data;
    }

    function bookingInput(req) {
        const b = req.body || {};
        const weightG = Math.ceil(Number(b.weight_g));
        const lengthCm = Math.ceil(Number(b.length_cm));
        const widthCm = Math.ceil(Number(b.width_cm ?? b.breadth_cm));
        const heightCm = Math.ceil(Number(b.height_cm));
        const locationId = String(b.fulfilment_location_id || '').trim();
        const description = clean(b.package_description, 500);
        const serviceRaw = String(b.service || process.env.EKART_DEFAULT_SERVICE || 'SURFACE').trim().toUpperCase();
        const service = ['SURFACE', 'EXPRESS'].includes(serviceRaw) ? serviceRaw : 'SURFACE';

        if (!uuid(locationId)) throw httpError(400, 'Choose a valid seller pickup location.', 'PICKUP_LOCATION');
        if (!Number.isSafeInteger(weightG) || weightG < 1 || weightG > 100000) {
            throw httpError(400, 'Packed weight must be between 1 and 100000 grams.', 'WEIGHT');
        }
        for (const [label, value] of [['length', lengthCm], ['width', widthCm], ['height', heightCm]]) {
            if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
                throw httpError(400, `Parcel ${label} must be between 1 and 500 cm.`, 'DIMENSIONS');
            }
        }
        return { locationId, weightG, lengthCm, widthCm, heightCm, description, service };
    }

    // ------------------------------------------------------------
    // Shipment lookup helpers exposed to seller-orders module.
    // ------------------------------------------------------------
    async function attachShipments(orders, sellerId) {
        await ensureSchema();
        const list = Array.isArray(orders) ? orders : [];
        if (!list.length) return list;
        const rows = await query(
            `SELECT * FROM public.cerood_ekart_shipments
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
            return row ? { ...order, ekart_shipment: publicShipment(row) } : order;
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
        let sql = `SELECT * FROM public.cerood_ekart_shipments
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
        if (!row || !row.tracking_id || ['cancelled', 'booking_unknown', 'failed'].includes(String(row.booking_state || '').toLowerCase())) {
            throw httpError(409, 'Create a valid Ekart AWB/pickup before marking this seller item as shipped.', 'AWB_REQUIRED');
        }
        return publicShipment(row);
    }

    async function refreshShipmentRow(row) {
        if (!row?.tracking_id) throw httpError(409, 'This Ekart shipment has no AWB/tracking ID yet.', 'NO_AWB');
        let response;
        try {
            response = await axios.get(
                `${EKART_BASE_URL}/api/v1/track/${encodeURIComponent(row.tracking_id)}`,
                { timeout: 20_000, maxContentLength: 2 * 1024 * 1024 }
            );
        } catch (error) {
            throw httpError(502, `Ekart tracking is temporarily unavailable: ${safeEkartMessage(error, 'tracking request failed')}`, 'TRACKING_UNAVAILABLE');
        }
        const data = response.data || {};
        const status = clean(data?.track?.status || data?.track?.desc || data?.status || 'booked', 160);
        const rows = await query(
            `UPDATE public.cerood_ekart_shipments
                SET last_tracking=?::jsonb,last_tracking_status=?,last_tracking_at=NOW(),updated_at=NOW(),
                    booking_state=CASE
                        WHEN cancelled_at IS NOT NULL THEN booking_state
                        WHEN LOWER(?) IN ('delivered','shipment delivered') THEN 'delivered'
                        WHEN LOWER(?) IN ('picked_up','picked up','in_transit','in transit','out_for_delivery','out for delivery') THEN 'in_transit'
                        ELSE booking_state
                    END
              WHERE id=? RETURNING *`,
            [JSON.stringify(data), status || null, status, status, row.id]
        );
        return rows[0] || row;
    }

    // ------------------------------------------------------------
    // Seller routes.
    // ------------------------------------------------------------
    app.get('/api/sellers/ekart/status', requireSellerAuth, async (req, res) => {
        try {
            await ensureSchema();
            return res.json({
                success: true,
                configured: Boolean(process.env.EKART_CLIENT_ID && process.env.EKART_USERNAME && process.env.EKART_PASSWORD),
                service: String(process.env.EKART_DEFAULT_SERVICE || 'SURFACE').toUpperCase() === 'EXPRESS' ? 'EXPRESS' : 'SURFACE'
            });
        } catch (error) {
            return res.status(503).json({ success: false, message: 'Ekart shipping schema is unavailable.' });
        }
    });

    app.post('/api/sellers/locations/:id/ekart-register', requireSellerAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            await ensureSchema();
            const pickup = await loadSellerLocation(req.seller.id, req.params.id);
            const alias = await ensurePickupAlias(pickup);
            return res.json({ success: true, alias, message: 'Seller pickup location is registered with Ekart.' });
        } catch (error) {
            console.error('Ekart pickup registration:', error.code || error.message);
            return res.status(error.status || 502).json({ success: false, message: error.message || 'Unable to register Ekart pickup location.' });
        }
    });

    app.post('/api/seller/orders/:orderItemId/ekart-shipment', requireSellerAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        let bookingRow;
        let bookingAttempted = false;
        try {
            await ensureSchema();
            const ref = parseOrderItemRef(req.params.orderItemId);
            if (!ref) throw httpError(400, 'Invalid seller order item.', 'ORDER_ITEM');
            const input = bookingInput(req);
            const pickup = await loadSellerLocation(req.seller.id, input.locationId);
            const parcel = await loadParcel(ref, req.seller.id, input.locationId);

            const incomingKey = clean(req.get('Idempotency-Key'), 220);
            const idempotencyKey = incomingKey || `seller:${req.seller.id}:${shipmentGroupKey(parcel)}`.slice(0, 220);
            const reserved = await reserveBooking(parcel, input, idempotencyKey);
            bookingRow = reserved.row;
            if (reserved.existing) {
                return res.json({
                    success: true,
                    already_created: true,
                    message: 'This seller parcel already has an Ekart shipment. Duplicate booking was blocked.',
                    shipment: publicShipment(bookingRow)
                });
            }

            const alias = await ensurePickupAlias(pickup);
            const serviceability = await serviceabilityCheck(parcel, pickup, input);
            await query(
                `UPDATE public.cerood_ekart_shipments
                    SET pickup_alias=?,serviceability_response=?::jsonb,updated_at=NOW()
                  WHERE id=?`,
                [alias, JSON.stringify(serviceability), bookingRow.id]
            );

            bookingAttempted = true;
            const response = await createShipment(parcel, pickup, alias, bookingRow, input);
            if (response?.status === false) {
                throw httpError(409, clean(response?.remark || response?.message || 'Ekart rejected shipment creation.', 500), 'EKART_REJECTED');
            }
            const trackingId = clean(response?.tracking_id, 140);
            if (!trackingId) {
                throw httpError(502, 'Ekart returned an uncertain shipment result without a tracking ID. Verify in Ekart before retrying.', 'EKART_UNCERTAIN');
            }

            const rows = await query(
                `UPDATE public.cerood_ekart_shipments
                    SET booking_state='booked',tracking_id=?,vendor=?,pickup_alias=?,ekart_response=?::jsonb,
                        booked_at=NOW(),last_error=NULL,updated_at=NOW()
                  WHERE id=? RETURNING *`,
                [trackingId, clean(response?.vendor, 140) || null, alias, JSON.stringify(response), bookingRow.id]
            );
            const saved = rows[0];
            return res.status(201).json({
                success: true,
                message: `Ekart AWB ${trackingId} created for this seller parcel.`,
                shipment: publicShipment(saved)
            });
        } catch (error) {
            const responseStatus = Number(error.response?.status || 0);
            const message = error.status
                ? error.message
                : safeEkartMessage(error, 'Ekart shipment creation failed.');

            if (bookingRow?.id) {
                const uncertain = bookingAttempted && (!error.response || responseStatus >= 500 || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'EKART_UNCERTAIN');
                await setBookingFailure(bookingRow.id, uncertain ? 'booking_unknown' : 'failed', message);
            }

            console.error('Ekart shipment booking:', error.code || responseStatus || error.message);
            const status = error.status || (responseStatus >= 400 && responseStatus < 500 ? 409 : 502);
            return res.status(status).json({ success: false, code: error.code || undefined, message });
        }
    });

    app.post('/api/seller/orders/:orderItemId/ekart-shipment/refresh', requireSellerAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const found = await findShipmentForItem(req.params.orderItemId, req.seller.id);
            if (!found.shipment) throw httpError(404, 'Ekart shipment was not found.', 'SHIPMENT_NOT_FOUND');
            const row = await refreshShipmentRow(found.shipment);
            return res.json({ success: true, shipment: publicShipment(row) });
        } catch (error) {
            return res.status(error.status || 502).json({ success: false, message: error.message || 'Unable to refresh Ekart tracking.' });
        }
    });

    app.get('/api/seller/orders/:orderItemId/ekart-label', requireSellerAuth, async (req, res) => {
        try {
            const found = await findShipmentForItem(req.params.orderItemId, req.seller.id);
            if (!found.shipment?.tracking_id) throw httpError(404, 'Ekart AWB was not found.', 'NO_AWB');
            const response = await ekartAuthedRequest({
                method: 'POST',
                url: '/api/v1/package/label?json_only=false',
                data: { ids: [found.shipment.tracking_id] },
                headers: { 'Content-Type': 'application/json' },
                responseType: 'arraybuffer',
                timeout: 30_000,
                maxContentLength: 10 * 1024 * 1024,
                maxBodyLength: 64 * 1024
            });
            res.set('Cache-Control', 'private, no-store');
            res.set('Content-Type', 'application/pdf');
            res.set('Content-Disposition', `attachment; filename="ekart-${found.shipment.tracking_id}.pdf"`);
            return res.send(Buffer.from(response.data));
        } catch (error) {
            if (res.headersSent) return;
            return res.status(error.status || 502).json({ success: false, message: error.message || 'Unable to download Ekart label.' });
        }
    });

    // ------------------------------------------------------------
    // Admin routes. These expose Ekart state to admin but DO NOT
    // change CEROOD customer delivery_status automatically.
    // ------------------------------------------------------------
    app.get('/api/admin/ekart/shipments', requireAdminAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            await ensureSchema();
            const rows = await query(
                `SELECT e.*,s.shop_name,s.owner_name,l.location_name,l.pincode AS pickup_pincode
                   FROM public.cerood_ekart_shipments e
                   JOIN public.cerood_sellers s ON s.id=e.seller_id
                   JOIN public.cerood_seller_locations l ON l.id=e.fulfilment_location_id
                  ORDER BY e.created_at DESC
                  LIMIT 500`
            );
            return res.json({ success: true, shipments: rows.map(row => ({ ...publicShipment(row), shop_name: row.shop_name, owner_name: row.owner_name, location_name: row.location_name, pickup_pincode: row.pickup_pincode })) });
        } catch (error) {
            console.error('Admin Ekart list:', error.message);
            return res.status(500).json({ success: false, message: 'Unable to load Ekart shipments.' });
        }
    });

    app.post('/api/admin/ekart/shipments/:id/refresh', requireAdminAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            await ensureSchema();
            if (!uuid(req.params.id)) throw httpError(400, 'Invalid shipment.', 'SHIPMENT_ID');
            const rows = await query(`SELECT * FROM public.cerood_ekart_shipments WHERE id=? LIMIT 1`, [req.params.id]);
            if (!rows.length) throw httpError(404, 'Ekart shipment was not found.', 'SHIPMENT_NOT_FOUND');
            const row = await refreshShipmentRow(rows[0]);
            return res.json({ success: true, shipment: publicShipment(row) });
        } catch (error) {
            return res.status(error.status || 502).json({ success: false, message: error.message || 'Unable to refresh Ekart shipment.' });
        }
    });

    app.post('/api/admin/ekart/shipments/:id/cancel', requireAdminAuth, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            await ensureSchema();
            if (!uuid(req.params.id)) throw httpError(400, 'Invalid shipment.', 'SHIPMENT_ID');
            const rows = await query(`SELECT * FROM public.cerood_ekart_shipments WHERE id=? LIMIT 1`, [req.params.id]);
            const row = rows[0];
            if (!row) throw httpError(404, 'Ekart shipment was not found.', 'SHIPMENT_NOT_FOUND');
            if (!row.tracking_id) throw httpError(409, 'This shipment has no Ekart tracking ID.', 'NO_AWB');
            if (row.cancelled_at) return res.json({ success: true, already_cancelled: true, shipment: publicShipment(row) });

            const response = await ekartAuthedRequest({
                method: 'DELETE',
                url: `/api/v1/package/cancel?tracking_id=${encodeURIComponent(row.tracking_id)}`,
                timeout: 20_000,
                maxContentLength: 2 * 1024 * 1024
            });
            if (response.data?.status === false) {
                throw httpError(409, clean(response.data?.remark || 'Ekart rejected cancellation.', 500), 'CANCEL_REJECTED');
            }
            const saved = await query(
                `UPDATE public.cerood_ekart_shipments
                    SET booking_state='cancelled',cancelled_at=NOW(),ekart_response=?::jsonb,updated_at=NOW()
                  WHERE id=? RETURNING *`,
                [JSON.stringify(response.data || {}), row.id]
            );
            return res.json({ success: true, message: 'Ekart shipment cancelled. CEROOD order/customer status was not changed.', shipment: publicShipment(saved[0]) });
        } catch (error) {
            const message = error.status ? error.message : safeEkartMessage(error, 'Unable to cancel Ekart shipment.');
            return res.status(error.status || 502).json({ success: false, message });
        }
    });

    return {
        ensureSchema,
        attachShipments,
        assertBookedForItem,
        findShipmentForItem,
        publicShipment
    };
};
