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
    hint.textContent = '沿用这里的渠道 URL、API Key 和模型 ID。旧版 8010 地址请换回渠道地址。';
    const auth = document.createElement('select');
    auth.className = 'text_pole wide100p';
    auth.setAttribute('aria-label', '渠道认证方式');
    const row = document.createElement('div');
    row.append(setting, select, auth, hint);
    form.prepend(row);

    const storageKey = 'st-native-bridge-protocol';
    let protocol = 'openai';
    try {
        const saved = localStorage.getItem(storageKey);
        if (['openai', 'gemini', 'claude'].includes(saved)) protocol = saved;
    } catch { /* The selector still works for this page. */ }
    const authOptions = {
        gemini: [['default', '默认（x-goog-api-key）'], ['bearer', 'Authorization: Bearer'], ['query-key', 'URL 参数 key']],
        claude: [['default', '默认（x-api-key）'], ['bearer', 'Authorization: Bearer']],
    };
    function render() {
        select.value = protocol;
        const native = protocol !== 'openai';
        auth.hidden = hint.hidden = !native;
        auth.replaceChildren();
        if (!native) return;
        for (const [value, label] of authOptions[protocol]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            auth.append(option);
        }
        auth.value = 'default';
        try {
            const saved = localStorage.getItem(`${storageKey}-${protocol}-auth`);
            if (authOptions[protocol].some(([value]) => saved === value)) auth.value = saved;
        } catch { /* Default authentication. */ }
    }
    select.addEventListener('change', () => {
        protocol = select.value;
        try { localStorage.setItem(storageKey, protocol); } catch { /* Page only. */ }
        render();
    });
    auth.addEventListener('change', () => {
        try { localStorage.setItem(`${storageKey}-${protocol}-auth`, auth.value); } catch { /* Page only. */ }
    });
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = function (url, options) {
        const route = typeof url === 'string' && /^\/api\/backends\/chat-completions\/(generate|status)$/.exec(url);
        if (!route || protocol === 'openai' || options?.method !== 'POST' || typeof options.body !== 'string') return originalFetch(url, options);
        let body;
        try { body = JSON.parse(options.body); } catch { return originalFetch(url, options); }
        if (body?.chat_completion_source !== 'custom') return originalFetch(url, options);
        return originalFetch(`/api/plugins/native-bridge/${route[1]}`, {
            ...options,
            body: JSON.stringify({ ...body, native_bridge_protocol: protocol, native_bridge_auth: auth.value }),
        });
    };
    render();
})();
