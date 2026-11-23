'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { InputError, makeRequest, endpoint, normalize, toUsage, sse } = require('./protocol.cjs');

const info = {
    id: 'native-bridge',
    name: 'Native Gemini & Claude Bridge',
    description: 'Connects SillyTavern custom connections directly to native Claude and Gemini endpoints.',
};
const providers = ['claude', 'gemini'];
const requestTimeout = 5 * 60 * 1000;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
}

function errorData(message, type) {
    return { error: { message, type } };
}

function headersFor(provider, entry) {
    const headers = { 'Content-Type': 'application/json' };
    if (provider === 'claude') headers['anthropic-version'] = '2023-06-01';
    if (entry.auth === 'bearer') headers.Authorization = `Bearer ${entry.apiKey}`;
    else if (entry.auth !== 'query-key') headers[entry.auth] = entry.apiKey;
    return headers;
}

async function sendSse(res, payload, signal) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (!res.write(`data: ${data}\n\n`)) await once(res, 'drain', { signal });
}

async function sendStream(res, upstream, provider, metadata, includeUsage, signal) {
    const send = (delta, reason = null) => sendSse(res, {
        ...metadata, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: reason }],
    }, signal);
    let usage;
    let finish;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    await send({ role: 'assistant' });
    const sources = /text\/event-stream/i.test(upstream.headers.get('content-type') ?? '')
        ? sse(upstream.body) : null;
    if (sources) {
        for await (const item of sources) {
            if (item.data.trim() === '[DONE]') break;
            const state = normalize(provider, JSON.parse(item.data), true, item.event);
            if (Object.keys(state.delta).length) await send(state.delta);
            if (state.usage) usage = { ...usage, ...state.usage };
            if (state.reason) finish = state.reason;
            if (state.done) break;
        }
        if (!finish) throw new Error('Upstream stream was interrupted.');
    } else {
        // Some compatible providers return a JSON completion despite stream: true.
        const raw = await upstream.json();
        for (const item of Array.isArray(raw) ? raw : [raw]) {
            const state = normalize(provider, item, false);
            if (Object.keys(state.delta).length) await send(state.delta);
            if (state.usage) usage = { ...usage, ...state.usage };
            if (state.reason) finish = state.reason;
        }
    }
    await send({}, finish ?? 'stop');
    if (includeUsage && usage) await sendSse(res, {
        ...metadata, object: 'chat.completion.chunk', choices: [], usage: toUsage(provider, usage),
    }, signal);
    await sendSse(res, '[DONE]', signal);
    res.end();
}

function validateConnection(body) {
    const provider = body?.native_bridge_protocol;
    if (body?.chat_completion_source !== 'custom' || !providers.includes(provider)) throw new InputError('Select a native protocol under Custom.');
    let baseUrl;
    try { baseUrl = new URL(body.custom_url); } catch { throw new InputError('Enter the channel Base URL in Custom Endpoint.'); }
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash ||
        !(baseUrl.protocol === 'https:' || (baseUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)))) {
        throw new InputError('Use HTTPS or loopback HTTP without credentials, query parameters or fragments.');
    }
    if (baseUrl.port === '8010' && baseUrl.hostname === '127.0.0.1' && /^\/(claude|gemini)\/v1\/?$/.test(baseUrl.pathname)) {
        throw new InputError('Replace the old 8010 address with your channel Base URL.');
    }
    const standard = provider === 'claude' ? 'x-api-key' : 'x-goog-api-key';
    const auth = body.native_bridge_auth === 'default' ? standard : body.native_bridge_auth ?? standard;
    if (![standard, 'bearer', ...(provider === 'gemini' ? ['query-key'] : [])].includes(auth)) {
        throw new InputError('Invalid authentication mode for the selected protocol.');
    }
    return { provider, baseUrl, auth };
}

function createHandler(getKey, statusOnly = false) {
    return async (req, res) => {
        if (!req.user?.directories) return json(res, 401, errorData('SillyTavern session required.', 'authentication_error'));
        let entry;
        try {
            entry = validateConnection(req.body);
        } catch (err) {
            return json(res, 400, errorData(err.message, 'invalid_request_error'));
        }
        if (statusOnly) {
            const model = typeof req.body.model === 'string' ? req.body.model.trim() : '';
            return json(res, 200, { bypass: true, data: model ? [{ id: model, object: 'model' }] : [] });
        }
        const { provider } = entry;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeout);
        const abort = () => controller.abort();
        res.once('close', abort);
        try {
            const body = req.body;
            entry.apiKey = getKey(req.user.directories);
            if (!entry.apiKey || !/^[\x21-\x7e]+$/.test(entry.apiKey)) throw new InputError('Set your channel API key in SillyTavern’s Custom API Key field.');
            const request = makeRequest(provider, body);
            const stream = body.stream === true;
            const url = endpoint(provider, entry.baseUrl, body.model, stream);
            if (entry.auth === 'query-key') url.searchParams.set('key', entry.apiKey);
            const upstream = await fetch(url, {
                method: 'POST', headers: headersFor(provider, entry), body: JSON.stringify(request),
                signal: controller.signal, redirect: 'error',
            });
            if (!upstream.ok) {
                await upstream.body?.cancel().catch(() => {});
                return json(res, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
                    errorData(`${provider} returned HTTP ${upstream.status}; check the endpoint, credentials and model.`, 'upstream_error'));
            }
            const metadata = { id: `chatcmpl-${randomUUID()}`, model: body.model, created: Math.floor(Date.now() / 1000) };
            if (stream) return await sendStream(res, upstream, provider, metadata, body.stream_options?.include_usage === true, controller.signal);
            const state = normalize(provider, await upstream.json(), false);
            return json(res, 200, {
                ...metadata, object: 'chat.completion', usage: toUsage(provider, state.usage),
                choices: [{ index: 0, message: { role: 'assistant', content: '', ...state.delta }, finish_reason: state.reason ?? 'stop' }],
            });
        } catch (err) {
            if (res.destroyed) return;
            const timedOut = controller.signal.aborted;
            const failure = err instanceof InputError ? errorData(err.message, 'invalid_request_error')
                : errorData(timedOut ? 'Provider request timed out.' : 'Provider response failed; check the configured endpoint and protocol.', 'upstream_error');
            if (!res.headersSent) return json(res, err instanceof InputError ? 400 : timedOut ? 504 : 502, failure);
            res.end(`data: ${JSON.stringify(failure)}\n\n`);
        } finally {
            clearTimeout(timer);
            res.off('close', abort);
            controller.abort();
        }
    };
}

async function init(router) {
    const stSecrets = path.join(__dirname, '..', '..', 'src', 'endpoints', 'secrets.js');
    const { readSecret, SECRET_KEYS } = await import(pathToFileURL(stSecrets).href);
    const getKey = directories => readSecret(directories, SECRET_KEYS.CUSTOM);
    router.post('/generate', createHandler(getKey));
    router.post('/status', createHandler(getKey, true));
}

if (require.main === module) {
    if (process.argv[2] === '--install-ui') {
        const root = path.resolve(__dirname, '..', '..');
        const extensions = path.join(root, 'public', 'scripts', 'extensions', 'third-party');
        const destination = path.join(extensions, 'native-bridge-selector');
        try {
            if (path.basename(path.dirname(__dirname)) !== 'plugins' || !fs.existsSync(path.join(root, 'plugins.js'))) {
                throw new Error('Run --install-ui from the plugin directory installed inside SillyTavern.');
            }
            fs.mkdirSync(extensions, { recursive: true });
            fs.mkdirSync(destination, { recursive: true });
            for (const file of ['manifest.json', 'index.js', 'native.mjs']) fs.copyFileSync(path.join(__dirname, 'ui', file), path.join(destination, file));
            console.log('Installed protocol selector. Reload SillyTavern in your browser.');
        } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
        }
    } else {
        console.error('Usage: node index.cjs --install-ui');
        process.exitCode = 1;
    }
}

module.exports = { info, init, createHandler };
