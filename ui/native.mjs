export function nativeRequest(body, protocol, key) {
    let url;
    try { url = new URL(body.custom_url); } catch { throw new Error('请填写渠道 Base URL。'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        throw new Error('渠道 URL 必须是 HTTPS（本机回环可用 HTTP）。');
    }
    if (url.username || url.password || url.search || url.hash) throw new Error('渠道 URL 不要包含凭据、查询参数或片段。');
    if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('请在模型 ID 栏填写渠道提供的模型名。');
    if (protocol === 'gemini' && !/^[\x21-\x7e]+$/.test(key)) throw new Error('Gemini 的 URL 参数认证不能使用空白或非 ASCII 字符。');
    if (protocol === 'gemini' && (/[\p{Cc}\p{Cs}]/u.test(body.model) || body.model.split('/').some(x => !x || x === '.' || x === '..'))) throw new Error('模型 ID 包含无效字符。');
    if (body.tools?.length || body.json_schema) throw new Error('免服务端模式暂不支持工具调用或结构化输出。');
    const path = url.pathname.replace(/\/+$/, '');
    const claude = protocol === 'claude';
    if (claude) {
        url.pathname = (path.replace(/\/v1(?:\/messages)?$/, '') || '') + '/v1';
    } else {
        // SillyTavern appends its configured Gemini version and model path.
        url.pathname = path.replace(/\/v1(?:beta|alpha)?(?:\/models(?:\/[^/]+:(?:streamGenerateContent|generateContent))?)?$/, '') || '/';
    }
    return {
        ...body,
        chat_completion_source: claude ? 'claude' : 'makersuite',
        reverse_proxy: url.toString(),
        proxy_password: claude ? key : encodeURIComponent(key),
        model: claude ? body.model : encodeURIComponent(body.model.replace(/^models\//, '')),
        use_sysprompt: true,
        include_reasoning: body.include_reasoning ?? false,
    };
}

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export function nativeStream(response, protocol, eventStream) {
    const encoder = new TextEncoder();
    const reader = response.body.pipeThrough(eventStream).getReader();
    return new Response(new ReadableStream({
        async pull(controller) {
            const send = data => controller.enqueue(encoder.encode(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`));
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done || value.data === '[DONE]') {
                        send('[DONE]');
                        controller.close();
                        if (!done) await reader.cancel();
                        return;
                    }
                    const raw = JSON.parse(value.data);
                    if (raw.error || raw.type === 'error' || value.type === 'error' || raw.promptFeedback?.blockReason) {
                        throw new Error('渠道中止了生成，请检查渠道、模型及认证配置。');
                    }
                    const delta = {};
                    if (protocol === 'claude') {
                        const part = raw.delta ?? raw.content_block;
                        if (part?.text) delta.content = part.text;
                        if (part?.thinking) delta.reasoning_content = part.thinking;
                    } else {
                        for (const part of raw.candidates?.[0]?.content?.parts ?? []) {
                            if (typeof part.text !== 'string') continue;
                            const key = part.thought ? 'reasoning_content' : 'content';
                            delta[key] = (delta[key] ?? '') + part.text;
                        }
                    }
                    if (Object.keys(delta).length) {
                        send({ choices: [{ index: 0, delta }] });
                        return;
                    }
                }
            } catch (error) {
                if (error.name === 'AbortError') controller.error(error);
                else {
                    send({ error: { message: '原生渠道流式回复失败，请检查渠道与模型。' } });
                    controller.close();
                }
                await reader.cancel().catch(() => {});
            }
        },
        cancel(reason) { return reader.cancel(reason); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
}

export function nativeJson(raw, protocol) {
    if (raw.error || !Array.isArray(raw.choices)) return jsonResponse({ error: { message: '渠道未返回有效回复，请检查模型与认证配置。' } }, 502);
    const parts = protocol === 'claude' ? raw.content : raw.responseContent?.parts;
    const text = protocol === 'claude' ? parts?.filter(p => p.type === 'text').map(p => p.text).join('') : raw.choices[0]?.message?.content;
    return jsonResponse({ ...raw, choices: [{ index: 0, message: { role: 'assistant', content: text ?? raw.choices[0]?.message?.content ?? '' } }] });
}
