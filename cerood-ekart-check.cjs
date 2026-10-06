#!/usr/bin/env node
'use strict';

/*
 * Cerood - Ekart connection check (Node.js 18+).
 * Based on the supplied Ekart OpenAPI document, version 3.8.10.
 * Run locally: node cerood-ekart-check.cjs
 * No npm packages or changes to server.js are needed.
 *
 * Checks: POST auth token, GET saved addresses, GET pincode serviceability.
 * It never books, cancels or edits a shipment or an address.
 * Passwords and tokens are not printed or written to a file.
 * Use the API username/password confirmed by Ekart.
 * Optional environment variables:
 * EKART_CLIENT_ID, EKART_USERNAME, EKART_PASSWORD, EKART_TEST_PINCODE.
 */

const readline = require('node:readline');
const BASE_URL = 'https://app.elite.ekartlogistics.in';
const DEFAULT_PINCODE = '635301';

function isPlaceholder(value) {
    return /^(string|your[_ -].*|client_id|\{client_id\})$/i.test(String(value));
}

function validateConfig(config) {
    if (!config || typeof config.clientId !== 'string' ||
        !config.clientId.trim() || isPlaceholder(config.clientId) ||
        /[\s{}\/\\?#]/.test(config.clientId)) {
        return 'Enter the real Client ID shown in Ekart Settings > API Documentation.';
    }
    if (typeof config.username !== 'string' || !config.username.trim() ||
        isPlaceholder(config.username)) {
        return 'Enter the API username confirmed by Ekart.';
    }
    if (typeof config.password !== 'string' || !config.password ||
        isPlaceholder(config.password) || /[\r\n]/.test(config.password)) {
        return 'Enter the API password privately in the terminal.';
    }
    if (typeof config.pincode !== 'string' || !/^[1-9]\d{5}$/.test(config.pincode)) {
        return 'Enter a valid six-digit Indian pincode.';
    }
    return null;
}

// Read a password from a real terminal with its echo disabled.
// Client credentials are never accepted as command-line arguments.
function askPassword(input = process.stdin, output = process.stdout) {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
        return Promise.reject(new Error('TERMINAL_REQUIRED'));
    }
    return new Promise((resolve, reject) => {
        let password = '';
        const wasRaw = Boolean(input.isRaw);
        output.write('API password (hidden): ');
        input.setEncoding('utf8');
        input.setRawMode(true);
        input.resume();

        const finish = (error) => {
            input.removeListener('data', onData);
            input.removeListener('end', onEnd);
            input.removeListener('error', onError);
            input.setRawMode(wasRaw);
            input.pause();
            output.write('\n');
            if (error) reject(error);
            else resolve(password);
        };
        const onEnd = () => finish(new Error('INPUT_CLOSED'));
        const onError = () => finish(new Error('INPUT_CLOSED'));
        const onData = (chunk) => {
            // Terminal navigation/escape sequences must not become credentials.
            const text = String(chunk).replace(/\x1b(?:\[[0-9;?]*[A-Za-z~]|O.)/g, '');
            for (const char of text) {
                if (char === '\u0003') return finish(new Error('CANCELLED'));
                if (char === '\r' || char === '\n') return finish();
                if (char === '\u0004') return finish(new Error('INPUT_CLOSED'));
                if (char === '\u007f' || char === '\b') {
                    if (password.length) {
                        password = Array.from(password).slice(0, -1).join('');
                        output.write('\b \b');
                    }
                } else if (char === '\u0015') {
                    output.write('\b \b'.repeat(Array.from(password).length));
                    password = '';
                } else if (char >= ' ' && char !== '\u001b') {
                    password += char;
                    output.write('*');
                }
            }
        };
        input.on('data', onData);
        input.once('end', onEnd);
        input.once('error', onError);
    });
}

async function getConfig(env = process.env) {
    const config = {
        clientId: String(env.EKART_CLIENT_ID || '').trim(),
        username: String(env.EKART_USERNAME || '').trim(),
        password: env.EKART_PASSWORD || '',
        pincode: String(env.EKART_TEST_PINCODE || DEFAULT_PINCODE).trim()
    };
    const needPrompt = !config.clientId || !config.username || !config.password;
    if (needPrompt) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw new Error('TERMINAL_REQUIRED');
        }
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (label) => new Promise((resolve) => rl.question(label, resolve));
        try {
            if (!config.clientId) config.clientId = (await question('Ekart Client ID: ')).trim();
            if (!config.username) config.username = (await question('Ekart API username: ')).trim();
            if (!env.EKART_TEST_PINCODE) {
                config.pincode = (await question('Serviceability pincode [635301]: ')).trim() || DEFAULT_PINCODE;
            }
        } finally {
            rl.close();
        }
        if (!config.password) config.password = await askPassword();
    }
    return config;
}

async function requestJson(fetchImpl, path, options) {
    try {
        const response = await fetchImpl(BASE_URL + path, {
            ...options,
            redirect: 'error',
            signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) {
            // Do not echo a vendor error body: it may contain submitted secrets.
            if (response.body && typeof response.body.cancel === 'function') {
                await response.body.cancel().catch(() => {});
            }
            return { ok: false, http_status: response.status, error: 'HTTP_REQUEST_REJECTED' };
        }
        try {
            const data = await response.json();
            return { ok: true, http_status: response.status, data };
        } catch (_) {
            return { ok: false, http_status: response.status, error: 'INVALID_JSON_RESPONSE' };
        }
    } catch (error) {
        return { ok: false, error: error && error.name === 'TimeoutError' ?
            'REQUEST_TIMED_OUT' : 'NETWORK_TLS_OR_REDIRECT_ERROR' };
    }
}

async function runChecks(config, { fetchImpl = globalThis.fetch, progress = () => {} } = {}) {
    const validationError = validateConfig(config);
    if (validationError) return { configuration: { ok: false, message: validationError } };
    if (typeof fetchImpl !== 'function') {
        return { configuration: { ok: false, message: 'Run this file with Node.js 18 or newer.' } };
    }

    const report = {};
    progress('1/3 - Checking authentication...');
    const auth = await requestJson(fetchImpl,
        '/integrations/v2/auth/token/' + encodeURIComponent(config.clientId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ username: config.username, password: config.password })
        });
    if (!auth.ok) {
        report.authentication = auth;
        report.next_step = 'Confirm your Client ID, API username/password and API access with Ekart. Share only this report.';
        return report;
    }
    const tokenData = auth.data;
    if (!tokenData || typeof tokenData.access_token !== 'string' ||
        !tokenData.access_token.trim() || isPlaceholder(tokenData.access_token) ||
        tokenData.token_type !== 'Bearer' ||
        !Number.isFinite(tokenData.expires_in) || tokenData.expires_in <= 0) {
        report.authentication = { ok: false, http_status: auth.http_status, error: 'INVALID_TOKEN_RESPONSE' };
        report.next_step = 'Ekart did not return a valid token response. Confirm API access with Ekart.';
        return report;
    }
    report.authentication = {
        ok: true, http_status: auth.http_status, expires_in_seconds: tokenData.expires_in
    };

    const headers = { Accept: 'application/json', Authorization: 'Bearer ' + tokenData.access_token };
    progress('2/3 - Checking saved pickup/RTO addresses...');
    const addresses = await requestJson(fetchImpl, '/api/v2/addresses', { method: 'GET', headers });
    report.pickup_addresses = addresses.ok ?
        (Array.isArray(addresses.data) && addresses.data.every((address) =>
            address && typeof address.alias === 'string' && address.alias.trim()) ?
            { ok: true, http_status: addresses.http_status, count: addresses.data.length } :
            { ok: false, http_status: addresses.http_status, error: 'INVALID_ADDRESS_RESPONSE' }) : addresses;

    progress('3/3 - Checking pincode serviceability...');
    const availability = await requestJson(fetchImpl, '/api/v2/serviceability/' + config.pincode,
        { method: 'GET', headers });
    if (!availability.ok) {
        report.pincode_serviceability = availability;
    } else if (!availability.data || typeof availability.data.status !== 'boolean' ||
        Number(availability.data.pincode) !== Number(config.pincode)) {
        report.pincode_serviceability = {
            ok: false, http_status: availability.http_status, error: 'INVALID_SERVICEABILITY_RESPONSE'
        };
    } else {
        const details = availability.data.details;
        const hasDetails = details && ['forward_pickup', 'forward_drop', 'cod', 'reverse_pickup', 'reverse_drop']
            .every((field) => typeof details[field] === 'boolean');
        if (availability.data.status && !hasDetails) {
            report.pincode_serviceability = {
                ok: false, http_status: availability.http_status, error: 'INVALID_SERVICEABILITY_DETAILS'
            };
        } else {
            report.pincode_serviceability = {
                ok: true, http_status: availability.http_status, pincode: config.pincode,
                serviceable: availability.data.status
            };
            if (hasDetails) {
                Object.assign(report.pincode_serviceability, {
                    seller_pickup: details.forward_pickup,
                    customer_delivery: details.forward_drop,
                    cod_available: details.cod,
                    customer_reverse_pickup: details.reverse_pickup,
                    seller_reverse_delivery: details.reverse_drop
                });
                if (Number.isFinite(details.max_cod_amount)) {
                    report.pincode_serviceability.max_cod_amount = details.max_cod_amount;
                }
            }
        }
    }

    if (!report.pickup_addresses.ok || !report.pincode_serviceability.ok) {
        report.next_step = 'Authentication passed, but a read check failed. Share this report to identify the next step.';
    } else if (!report.pincode_serviceability.serviceable) {
        report.next_step = 'Read access passed, but this pincode is not serviceable. Confirm the intended pickup/delivery location with Ekart.';
    } else if (report.pickup_addresses.count === 0) {
        report.next_step = 'Read access passed. No pickup/RTO addresses are saved. The next step is to register and verify seller pickup locations.';
    } else {
        report.next_step = 'Connection checks completed. Share this report for the next integration step. Booking permissions and actual shipping costs are not tested.';
    }
    return report;
}

function exitStatus(report) {
    return report.authentication && report.authentication.ok &&
        report.pickup_addresses && report.pickup_addresses.ok &&
        report.pincode_serviceability && report.pincode_serviceability.ok ? 0 : 1;
}

async function main() {
    if (process.argv.includes('--help')) {
        console.log('Run: node cerood-ekart-check.cjs\nEnter your Client ID, confirmed API username, pincode and hidden password.\nDefault pincode: 635301. No npm install needed.\nOptional environment variables: EKART_CLIENT_ID, EKART_USERNAME, EKART_PASSWORD, EKART_TEST_PINCODE.\nDo not put credentials in command-line arguments or commit them to Git.\nChecks only authentication and read access; no shipment booking.');
        return;
    }
    console.log('CEROOD - EKART CONNECTION CHECK\nUse the API credentials confirmed by Ekart.\nPassword/token stay out of the printed report.\n');
    try {
        const config = await getConfig();
        const report = await runChecks(config, { progress: (line) => console.log(line) });
        console.log('\nSAFE REPORT - copy this result only:\n' + JSON.stringify(report, null, 2));
        process.exitCode = exitStatus(report);
    } catch (error) {
        const cancelled = error && error.message === 'CANCELLED';
        console.error(cancelled ? 'Cancelled. No further request was sent.' :
            'Open a real terminal and run: node cerood-ekart-check.cjs\nEnter credentials only in the terminal prompts, or configure the EKART environment variables privately.');
        process.exitCode = cancelled ? 130 : 1;
    }
}

module.exports = { runChecks, exitStatus, validateConfig, askPassword };
if (require.main === module) main();
