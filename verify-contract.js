// Offline regression guard. No network/database access.
const fs=require('fs');
const root=__dirname;
const server=fs.readFileSync(root+'/server.js','utf8');
const checkout=fs.readFileSync(root+'/checkout.html','utf8');
const sql=fs.readFileSync(root+'/migration.sql','utf8');
let failures=0;
function assert(name,ok){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failures++;}
const booking=server.slice(server.indexOf("app.post('/api/home-services/free-bookings'"),server.indexOf('// CEROOD HOME SERVICES — ADMIN INSPECTION'));
assert('Booking amount is zero', /\b0, 'Pending', 'Pending', 'Pay Later'/.test(booking));
assert('Booking returns 201 on success',/res\.status\(201\)/.test(booking));
assert('Duplicate request returns 409',/res\.status\(409\)/.test(booking));
assert('Booking uses unique request id',/ON CONFLICT \(booking_request_id\) DO NOTHING/.test(booking));
assert('Approval key stored as SHA-256 hash',/createHash\('sha256'\)/.test(booking));
assert('Approval key returned only on first insert',booking.indexOf('if (!inserted || !inserted.length)') < booking.indexOf('customer_approval_key: approvalKey'));
assert('Inspection acceptance requires pending fee',/inspection_fee_status='Awaiting Customer Confirmation'/.test(server));
assert('Quotation acceptance requires confirmed inspection',/inspection_fee_status='Confirmed' AND inspection_completed_at IS NOT NULL/.test(server));
assert('Customer consent does not auto mark paid',/No payment was taken/.test(server));
assert('Payment routes require approved quotation',/repair_quote_status='Accepted'/.test(server));
assert('Booking request id has unique index',/CREATE UNIQUE INDEX IF NOT EXISTS orders_booking_request_id_unique/.test(sql));
assert('Checkout contains free booking messaging',/Confirm Free Booking|Free Booking/i.test(checkout));
console.log(`Offline contract: ${failures?'FAILED':'PASSED'} (${12-failures}/12). Live behavior NOT verified.`);
process.exitCode=failures?1:0;
