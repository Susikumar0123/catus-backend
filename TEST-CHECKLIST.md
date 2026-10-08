# Cerood Home Services — ₹0 Booking staging checklist

## Before deployment
- Use a separate STAGING database/backend/frontend; back up the orders table.
- Verify existing `orders` columns include `customer_approval_key_hash`, `booking_fee`, `booking_pricing_model`, `inspection_fee_status`, `repair_quote_status`, and the other columns used by the new API. The included migration only adds `booking_request_id` and its unique index.
- Confirm `/customer-approval.html` exists and is deployed; it is NOT included in this ZIP.
- Verify authentication/authorization and inspection-fee approval flow independently before going live.

## Tests (record actual evidence; NOT yet run)
1. Complete checkout on desktop: confirm ₹0, no Razorpay popup, booking ID displayed.
2. Complete checkout on mobile: no horizontal overflow, booking ID and approval key visible.
3. Inspect DB: exactly one row, `booking_fee=0`, `amount=0`, `payment_method='Pay Later'`.
4. Submit same `booking_request_id` twice: first HTTP 201, second HTTP 409; only one DB row.
5. Refresh after a successful booking, then start a *new* booking: a fresh UUID is used.
6. Simulate network timeout after insert: retry same UUID, expect 409 and reconcile existing order through support. Do not create a new UUID automatically.
7. Confirm inspection charge must be disclosed and explicitly approved before technician visit.
8. Confirm repair quote requires separate approval after inspection.
9. Confirm Renewed/Clothing/Cosmetics checkout remains unchanged.
10. Verify Admin orders list and customer approval page against staging DB.

## Important
The booking endpoint currently accepts customer_id from the request body; assess identity-binding/auth requirements before production. A 409 response does not return a lost approval key, so failed-network recovery requires a secure support workflow. No browser, database or end-to-end test has been executed by this package build.
