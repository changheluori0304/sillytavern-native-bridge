import { jsonResponse, nativeJson, nativeRequest, nativeStream } from './native.mjs';

(() => {
    const form = document.querySelector('#custom_form');
    const urlField = form?.querySelector('#custom_api_url_text');
    if (!urlField || document.querySelector('#native_bridge_protocol')) return;

    const setting = document.createElement('label');
    setting.htmlFor = 'native_bridge_protocol';
    setting.textContent = '协议格式 / API format';
    const select = document.createElement('select');
    select.id = setting.htmlFor;
    select.className = 'text_pole wide100p';
    for (const [value, label] of [
        ['openai', 'OpenAI 兼容'], ['gemini', 'Gemini 兼容'], ['claude', 'Claude 兼容'],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        select.append(option);
    }
    const hint = document.createElement('small');
    hint.textContent = '模型 ID 手动填一次即可，连接时无需向渠道拉取模型。';
    const auth = document.createElement('select');
    auth.className = 'text_pole wide100p';
    auth.setAttribute('aria-label', '渠道认证方式');
    const keyField = document.createElement('input');
    keyField.type = 'password';
    keyField.autocomplete = 'off';
    keyField.className = 'text_pole wide100p';
    keyField.placeholder = '原生模式渠道 Key（仅保留在本页）';
    keyField.setAttribute('aria-label', keyField.placeholder);
    const row = document.createElement('div');
    row.append(setting, select, auth, keyField, hint);
    form.prepend(row);

    const storageKey = 'st-native-bridge-protocol';
    // Older versions only supported server-plugin auth. Do not inherit that selection on upgrade.
    const authStorageKey = `${storageKey}-auth-v2`;
    let protocol = 'openai';
    try {
        const saved = localStorage.getItem(storageKey);
        if (['openai', 'gemini', 'claude'].includes(saved)) protocol = saved;
    } catch { /* The selector still works for this page. */ }
    const authOptions = {
        gemini: [['native', '免服务端安装：URL 参数 key'], ['default', '服务端插件：x-goog-api-key'], ['bearer', '服务端插件：Bearer'], ['query-key', '服务端插件：URL 参数 key']],
        claude: [['native', '免服务端安装：x-api-key'], ['default', '服务端插件：x-api-key'], ['bearer', '服务端插件：Bearer']],
    };
    function renderKey() {
        keyField.hidden = protocol === 'openai' || auth.value !== 'native';
    }
    function render() {
        select.value = protocol;
        const native = protocol !== 'openai';
        auth.hidden = hint.hidden = !native;
        auth.replaceChildren();
        if (!native) return renderKey();
        for (const [value, label] of authOptions[protocol]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            auth.append(option);
        }
        auth.value = 'native';
        try {
            const saved = localStorage.getItem(`${authStorageKey}-${protocol}`);
            if (authOptions[protocol].some(([value]) => saved === value)) auth.value = saved;
        } catch { /* Default authentication. */ }
        renderKey();
    }
    select.addEventListener('change', () => {
        protocol = select.value;
        keyField.value = '';
        try { localStorage.setItem(storageKey, protocol); } catch { /* Page only. */ }
        render();
    });
    auth.addEventListener('change', () => {
        keyField.value = '';
        renderKey();
        try { localStorage.setItem(`${authStorageKey}-${protocol}`, auth.value); } catch { /* Page only. */ }
    });
    let keyUrl = '';
    keyField.addEventListener('input', () => { keyUrl = urlField.value.trim(); });
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async function (url, options) {
        const route = typeof url === 'string' && /^\/api\/backends\/chat-completions\/(generate|status)$/.exec(url);
        if (!route || protocol === 'openai' || options?.method !== 'POST' || typeof options.body !== 'string') return originalFetch(url, options);
        let body;
        try { body = JSON.parse(options.body); } catch { return originalFetch(url, options); }
        if (body?.chat_completion_source !== 'custom') return originalFetch(url, options);
        if (route[1] === 'status') body.model = form.querySelector('#custom_model_id')?.value ?? '';
        if (auth.value === 'native') {
            if (route[1] === 'status') return jsonResponse({ bypass: true, data: body.model ? [{ id: body.model }] : [] });
            const key = keyField.value.trim();
            if (!key || keyUrl !== String(body.custom_url).trim()) return jsonResponse({ error: { message: '请在协议下方的「原生模式渠道 Key」中为当前地址填写 Key。' } }, 400);
            const selected = protocol;
            let request;
            try { request = nativeRequest(body, selected, key); } catch (error) {
                return jsonResponse({ error: { message: error.message } }, 400);
            }
            const response = await originalFetch(url, { ...options, body: JSON.stringify(request) });
            if (!response.ok) return jsonResponse({ error: { message: `原生渠道请求失败（HTTP ${response.status}），请检查地址、模型和 Key。` } }, response.status);
            try {
                if (body.stream && /text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
                    const { getEventSourceStream } = await import('/scripts/sse-stream.js');
                    return nativeStream(response, selected, getEventSourceStream());
                }
                const result = nativeJson(await response.json(), selected);
                if (!body.stream || !result.ok) return result;
                const data = await result.json();
                return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                return jsonResponse({ error: { message: '原生渠道响应无法解析。' } }, 502);
            }
        }
        return originalFetch(`/api/plugins/native-bridge/${route[1]}`, {
            ...options,
            body: JSON.stringify({ ...body, native_bridge_protocol: protocol, native_bridge_auth: auth.value }),
        }).then(response => {
            if (response.status !== 404 || response.headers.get('content-type')?.includes('application/json')) return response;
            return new Response(JSON.stringify({ error: { message: '当前选的是服务端插件模式，但服务端未加载。只安装了扩展时，请在认证下拉框选「免服务端安装」，并填写该模式的渠道 Key。' } }), {
                status: 503, headers: { 'Content-Type': 'application/json' },
            });
        });
    };
    render();
})();
