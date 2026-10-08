# Cerood Home Services — Razorpay Test-Mode Gate

**Status: NOT approved for production.** This package contains the previously supplied staging code plus a test plan, not proof of successful live/test payments.

## Before tests
1. Use a separate staging Render service, staging Supabase database and Razorpay **test** credentials. Never run `migration.sql` on production without backup and review.
2. Configure `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and a separate `HOME_SERVICES_RAZORPAY_WEBHOOK_SECRET` in staging environment variables. Never publish secrets in HTML or logs.
3. Configure Razorpay test webhook at `/api/home-services/razorpay-webhook` for `payment.captured` and check delivery logs.
4. Use a test booking with `booking_pricing_model=quote_after_inspection`; verify booking fee ₹0, paid inspection separately, completed inspection, and customer-accepted repair quote.

## Manual end-to-end scenarios (record evidence for each)
| ID | Scenario | Expected |
|---|---|---|
| T01 | Customer rejects inspection fee | Cannot advance to inspection/quote payment |
| T02 | Customer confirms inspection fee, inspection not completed | Repair payment blocked |
| T03 | Inspection completed, quote not accepted | Repair payment blocked |
| T04 | Customer accepts ₹500 repair quote | Razorpay test order amount = 50000 paise, INR; inspection fee excluded |
| T05 | Double click payment and concurrent create requests | At most one payable Razorpay order for booking; no second charge |
| T06 | Test payment captured, callback received | DB final_payment_status paid, correct payment ID and amount |
| T07 | Payment captured, close browser before callback | Webhook/recovery reconciles paid without second charge |
| T08 | Same webhook event delivered twice | Idempotent; no duplicate updates or charges |
| T09 | Forged webhook signature | 401; no status change |
| T10 | Razorpay order create times out | Booking stays creating; support reconciliation; no blind retry |
| T11 | Failed/abandoned test payment | Clear retry/recovery path; no duplicate captured charge |
| T12 | Change repair quote after payment begins | Change rejected |
| T13 | Inspect Renewed/Clothing/Cosmetics checkout | Unchanged, functioning |
| T14 | Check mobile/desktop customer approval + checkout | No raw script leakage, payment UX accessible |

## Known blocking gaps found in current staging source
- Inspection fee collection is **not implemented**; `inspection_fee_status='Confirmed'` records customer consent, not proof of inspection payment.
- No durable webhook event audit table or support-side recovery endpoint for stuck `creating` bookings.
- Webhook code returns success for `not_found` events; requires an explicit policy and event audit before production.
- Browser refresh and failed-payment retry need complete testing and support reconciliation design.
- No Razorpay test transactions or deployment were performed in this review.

## Production release criteria
All scenarios pass with screenshots/logs; webhook replay and outage recovery verified; admin audit trail and access control reviewed; secrets rotated/secured; DB migration backup and rollback documented; finance confirms fees/refunds/tax invoices; owner explicitly authorizes production deployment.
