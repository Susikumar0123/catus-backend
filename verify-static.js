const fs = require('fs');
const assert = require('assert');
const server = fs.readFileSync('server.js', 'utf8');
const middleware = server.indexOf("app.use('/api/admin', requireAdminAuth)");
const orders = server.indexOf("app.get('/api/admin/orders'");
assert(middleware >= 0, 'Admin middleware missing');
assert(orders > middleware, 'Orders route precedes admin middleware');
assert(server.includes('function requireAdminAuth(req, res, next)'), 'Admin guard missing');
console.log('PASS: Admin middleware registered before orders route (static check only).');
