'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createHandler } = require('./index.cjs');

const fakeKey = 'temporary-test-provider-key';
const model = 'custom-model[测试]';

async function listen(t, server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    return `http://127.0.0.1:${server.address().port}`;
}

function app() {
    const send = createHandler(() => fakeKey);
    const status = createHandler(() => fakeKey, true);
    return http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        req.body = JSON.parse(Buffer.concat(chunks));
        if (req.headers['x-test-session']) req.user = { directories: {} };
        await (req.url.endsWith('/status') ? status : send)(req, res);
    });
}

const input = {
    model, max_tokens: 76, stop: ['END'], stream: false,
    messages: [
        { role: 'system', content: 'Leading instruction' },
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '第二句' },
        { role: 'system', content: 'Late instruction' },
        { role: 'user', content: [
            { type: 'text', text: '第三句' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ] },
    ],
};

const jsonByProvider = {
    claude: { content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: '答复 🌙' }],
        stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3 } },
    gemini: { candidates: [{ content: { parts: [{ thought: true, text: '思考' }, { text: '答复 🌙' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, thoughtsTokenCount: 1, cachedContentTokenCount: 3 } },
};

const streamByProvider = {
    claude: [
        { type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 3 } } },
        { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '思考' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: '答复 🌙' } },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
    ],
    gemini: [
        { candidates: [{ content: { parts: [{ thought: true, text: '思考' }] } }] },
        { candidates: [{ content: { parts: [{ text: '答复 🌙' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: jsonByProvider.gemini.usageMetadata },
    ],
};

test('Claude and Gemini: native requests, JSON and incrementally translated SSE', async t => {
    for (const provider of ['claude', 'gemini']) {
        await t.test(provider, async t => {
            const claude = provider === 'claude';
            const requests = [];
            let release;
            const restOfEvent = new Promise(resolve => { release = resolve; });
            const base = await listen(t, http.createServer(async (req, res) => {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                const body = JSON.parse(Buffer.concat(chunks));
                requests.push({ url: req.url, headers: req.headers, body });
                if (body.stream || req.url.includes(':streamGenerateContent')) {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    for (const event of streamByProvider[provider]) {
                        const data = Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`);
                        const split = data.indexOf(Buffer.from('答')) + 1;
                        if (split) {
                            res.write(data.subarray(0, split));
                            await restOfEvent;
                            res.write(data.subarray(split));
                        } else res.write(data);
                    }
                    res.end();
                } else {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(jsonByProvider[provider]));
                }
            }));
            const url = await listen(t, app());
            const connection = {
                chat_completion_source: 'custom', native_bridge_protocol: provider,
                custom_url: `${base}/relay${claude ? '/v1/messages' : '/v1beta/models/old:generateContent'}`,
                native_bridge_auth: claude ? 'default' : 'query-key',
            };
            const send = (body, route = 'generate', session = true) => fetch(`${url}/api/plugins/native-bridge/${route}`, {
                method: 'POST', headers: session ? { 'x-test-session': 'yes' } : {}, body: JSON.stringify({ ...body, ...connection }),
                signal: AbortSignal.timeout(3000),
            });
            assert.equal((await send({}, 'status', false)).status, 401);
            assert.deepEqual(await (await send({}, 'status')).json(), { bypass: true });
            const plain = await send(input);
            assert.equal(plain.status, 200);
            const { choices: [choice], usage } = await plain.json();
            assert.deepEqual(choice.message, { role: 'assistant', content: '答复 🌙', reasoning_content: '思考' });
            assert.equal(choice.finish_reason, 'length');
            assert.equal(usage.total_tokens, 10);
            assert.equal(usage.prompt_tokens_details.cached_tokens, 3);

            const streaming = await send({ ...input, stream: true, stream_options: { include_usage: true } });
            assert.match(streaming.headers.get('content-type'), /text\/event-stream/);
            let wire = '';
            let gotFirst = false;
            try {
                for await (const bytes of streaming.body.pipeThrough(new TextDecoderStream())) {
                    wire += bytes;
                    if (wire.includes('思考') && !gotFirst) {
                        assert.doesNotMatch(wire, /\[DONE\]/);
                        gotFirst = true;
                        release();
                    }
                }
            } finally { release(); }
            assert.ok(gotFirst);
            assert.match(wire, /答复 🌙/);
            assert.match(wire, /"finish_reason":"length"/);
            assert.match(wire, /"total_tokens":10/);
            assert.match(wire, /data: \[DONE\]\n\n$/);

            const { url: urlPath, body, headers } = requests[0];
            const turns = claude ? body.messages : body.contents;
            assert.equal(claude ? body.system : body.systemInstruction.parts[0].text, 'Leading instruction');
            assert.equal(turns[1].role, claude ? 'assistant' : 'model');
            assert.equal((turns[2].content ?? turns[2].parts)[0].text, 'Late instruction');
            if (claude) {
                assert.equal(urlPath, '/relay/v1/messages');
                assert.equal(headers['x-api-key'], fakeKey);
                assert.equal(headers['anthropic-version'], '2023-06-01');
                assert.equal(body.model, model);
                assert.equal(body.max_tokens, 76);
                assert.equal(turns[2].content[2].source.data, 'AA==');
            } else {
                const encoded = encodeURIComponent(model);
                assert.equal(urlPath, `/relay/v1beta/models/${encoded}:generateContent?key=${fakeKey}`);
                assert.equal(requests[1].url, `/relay/v1beta/models/${encoded}:streamGenerateContent?alt=sse&key=${fakeKey}`);
                assert.equal(body.generationConfig.maxOutputTokens, 76);
                assert.equal(turns[2].parts[2].inlineData.data, 'AA==');
            }
            assert.equal(headers.authorization, undefined);
        });
    }
});

test('does not expose provider error bodies or send credentials to redirect targets', async t => {
    let reached = false;
    const target = await listen(t, http.createServer((_req, res) => { reached = true; res.end(); }));
    const upstream = await listen(t, http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        if (body.model === 'redirect') res.writeHead(307, { Location: target });
        else res.writeHead(401);
        res.end(fakeKey);
    }));
    const url = await listen(t, app());
    for (const [name, status] of [['unauthorized', 401], ['redirect', 502]]) {
        const response = await fetch(`${url}/api/plugins/native-bridge/generate`, {
            method: 'POST', headers: { 'x-test-session': 'yes' }, body: JSON.stringify({
                ...input, model: name, chat_completion_source: 'custom', native_bridge_protocol: 'claude',
                custom_url: upstream, native_bridge_auth: 'bearer',
            }),
        });
        assert.equal(response.status, status);
        assert.ok(!(await response.text()).includes(fakeKey));
    }
    assert.equal(reached, false);
});
