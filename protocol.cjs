'use strict';

class InputError extends Error {}

function mapContent(content, provider) {
    if (typeof content === 'string') return [{ text: content }];
    if (!Array.isArray(content) || !content.length) throw new InputError('Expected non-empty message content.');
    return content.map(part => {
        if (part?.type === 'text' && typeof part.text === 'string') return { text: part.text };
        if (part?.type === 'image_url') {
            const image = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url?.url);
            if (!image) throw new InputError('Images must be embedded PNG, JPEG, GIF or WebP data URLs.');
            const [, mime, data] = image;
            return provider === 'claude'
                ? { type: 'image', source: { type: 'base64', media_type: mime, data } }
                : { inlineData: { mimeType: mime, data } };
        }
        throw new InputError('Unsupported message content type.');
    });
}

function makeRequest(provider, input) {
    if (typeof input?.model !== 'string' || !input.model.trim()) {
        throw new InputError('Enter the channel’s model ID in the Custom Model ID field.');
    }
    if (/[\p{Cc}\p{Cs}]/u.test(input.model) ||
        input.model.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new InputError('The model ID contains an invalid path segment or character.');
    }
    if (!Array.isArray(input.messages) || !input.messages.length) {
        throw new InputError('No chat messages were sent to the plugin.');
    }
    if (input.tools?.length || (input.n !== undefined && input.n !== 1) ||
        (input.response_format && input.response_format.type !== 'text')) {
        throw new InputError('Only one text completion is supported; disable tools and structured output.');
    }
    const system = [];
    const turns = [];
    const claude = provider === 'claude';
    for (const message of input.messages) {
        if (!['system', 'developer', 'assistant', 'user'].includes(message?.role) || message.tool_calls?.length) {
            throw new InputError('Unsupported chat role or tool call.');
        }
        const parts = mapContent(message.content, provider);
        const isSystem = message.role === 'system' || message.role === 'developer';
        if (isSystem && parts.some(part => part.text === undefined)) throw new InputError('System messages must be text.');
        // Only leading instructions become a global system prompt. Preserve later prompt injections in order.
        if (isSystem && !turns.length) {
            system.push(...parts.map(part => part.text));
            continue;
        }
        const role = message.role === 'assistant' ? (claude ? 'assistant' : 'model') : 'user';
        const content = claude ? parts.map(part => part.text === undefined ? part : { type: 'text', text: part.text }) : parts;
        if (turns.at(-1)?.role === role) turns.at(-1).parts.push(...content);
        else turns.push({ role, parts: content });
    }
    if (!turns.length) throw new InputError('At least one user or assistant message is required.');

    const limit = input.max_completion_tokens ?? input.max_tokens ?? 1024;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new InputError('Invalid output token limit.');
    const stops = typeof input.stop === 'string' ? [input.stop] : input.stop;
    if (stops != null && (!Array.isArray(stops) || stops.some(stop => typeof stop !== 'string'))) {
        throw new InputError('Invalid stop sequences.');
    }
    if (claude) {
        return {
            model: input.model,
            system: system.length ? system.join('\n\n') : undefined,
            messages: turns.map(({ role, parts }) => ({ role, content: parts })),
            max_tokens: limit,
            stream: input.stream === true,
            stop_sequences: stops?.length ? stops : undefined,
            // New Claude models can reject simultaneous temperature and top_p.
            temperature: Number.isFinite(input.temperature) ? Math.max(0, Math.min(1, input.temperature)) : undefined,
            top_p: !Number.isFinite(input.temperature) && Number.isFinite(input.top_p) ? input.top_p : undefined,
            top_k: input.top_k > 0 ? input.top_k : undefined,
        };
    }
    return {
        systemInstruction: system.length ? { parts: [{ text: system.join('\n\n') }] } : undefined,
        contents: turns,
        generationConfig: {
            maxOutputTokens: limit,
            stopSequences: stops?.length ? stops : undefined,
            temperature: Number.isFinite(input.temperature) ? input.temperature : undefined,
            topP: Number.isFinite(input.top_p) ? input.top_p : undefined,
            topK: input.top_k > 0 ? input.top_k : undefined,
            seed: Number.isInteger(input.seed) && input.seed >= 0 ? input.seed : undefined,
        },
    };
}

function endpoint(provider, baseUrl, model, stream) {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '');
    if (provider === 'claude') {
        url.pathname = path.endsWith('/v1/messages') ? path : path.endsWith('/v1') ? `${path}/messages` : `${path}/v1/messages`;
    } else {
        const models = /^(.*\/v1(?:beta|alpha)?\/models)(?:\/[^/]+:(?:streamGenerateContent|generateContent))?$/.exec(path);
        const root = models ? models[1] : /\/v1(?:beta|alpha)?$/.test(path) ? `${path}/models` : `${path}/v1beta/models`;
        url.pathname = `${root}/${encodeURIComponent(model.replace(/^models\//, ''))}:${stream ? 'streamGenerateContent' : 'generateContent'}`;
        if (stream) url.searchParams.set('alt', 'sse');
    }
    return url;
}

function finishReason(provider, reason) {
    if (!reason) return null;
    if (provider === 'claude') {
        return ({ max_tokens: 'length', refusal: 'content_filter', tool_use: 'tool_calls' })[reason] || 'stop';
    }
    if (reason === 'MAX_TOKENS') return 'length';
    return ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(reason) ? 'content_filter' : 'stop';
}

function partsToDelta(parts = []) {
    const delta = {};
    for (const part of parts) {
        if (typeof part.text !== 'string') continue;
        const key = part.thought ? 'reasoning_content' : 'content';
        delta[key] = (delta[key] ?? '') + part.text;
    }
    return delta;
}

function normalize(provider, data, stream, event) {
    if (!data || typeof data !== 'object' || data.error || event === 'error' || data.type === 'error') throw new Error('Provider returned an error.');
    if (provider === 'gemini') {
        if (!Array.isArray(data.candidates) && !data.promptFeedback && !data.usageMetadata) throw new Error('Invalid Gemini response.');
        const candidate = data.candidates?.[0];
        return {
            delta: partsToDelta(candidate?.content?.parts),
            reason: data.promptFeedback?.blockReason ? 'content_filter' : finishReason(provider, candidate?.finishReason),
            usage: data.usageMetadata,
        };
    }
    if (!stream) {
        if (!Array.isArray(data.content)) throw new Error('Invalid Claude response.');
        return {
            delta: partsToDelta(data.content.flatMap(part => part.type === 'text' ? [part]
                : part.type === 'thinking' ? [{ text: part.thinking, thought: true }] : [])),
            reason: finishReason(provider, data.stop_reason),
            usage: data.usage,
        };
    }
    const type = data.type ?? event;
    const part = type === 'content_block_start' ? data.content_block : type === 'content_block_delta' ? data.delta : null;
    const delta = partsToDelta(part && ['text', 'text_delta', 'thinking', 'thinking_delta'].includes(part.type)
        ? [{ text: part.text ?? part.thinking, thought: part.thinking !== undefined }] : []);
    return {
        delta,
        reason: type === 'message_delta' ? finishReason(provider, data.delta?.stop_reason) : null,
        usage: type === 'message_start' ? data.message?.usage : type === 'message_delta' ? data.usage : undefined,
        done: type === 'message_stop',
    };
}

function toUsage(provider, raw) {
    if (!raw) return undefined;
    if (provider === 'claude') {
        const prompt = (raw.input_tokens ?? 0) + (raw.cache_read_input_tokens ?? 0) + (raw.cache_creation_input_tokens ?? 0);
        const completion = raw.output_tokens ?? 0;
        return {
            prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
            prompt_tokens_details: { cached_tokens: raw.cache_read_input_tokens ?? 0 },
        };
    }
    const prompt = raw.promptTokenCount ?? 0;
    const completion = (raw.candidatesTokenCount ?? 0) + (raw.thoughtsTokenCount ?? 0);
    return {
        prompt_tokens: prompt, completion_tokens: completion, total_tokens: raw.totalTokenCount ?? prompt + completion,
        prompt_tokens_details: { cached_tokens: raw.cachedContentTokenCount ?? 0 },
        completion_tokens_details: { reasoning_tokens: raw.thoughtsTokenCount ?? 0 },
    };
}

async function* sse(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    let data = [];
    let event = '';
    async function* chunks() {
        for await (const chunk of body) yield decoder.decode(chunk, { stream: true });
        yield `${decoder.decode()}\n\n`;
    }
    for await (const chunk of chunks()) {
        buffer += chunk;
        if (buffer.length > 8 * 1024 * 1024) throw new Error('SSE line too large.');
        let consumed = 0;
        for (const match of buffer.matchAll(/\r\n|\n|\r(?!$)/g)) {
            const line = buffer.slice(consumed, match.index);
            consumed = match.index + match[0].length;
            if (line === '') {
                if (data.length) yield { event, data: data.join('\n') };
                data = [];
                event = '';
            } else if (line.startsWith('data:')) {
                data.push(line.slice(5).replace(/^ /, ''));
            } else if (line.startsWith('event:')) {
                event = line.slice(6).trim();
            }
        }
        buffer = buffer.slice(consumed);
    }
}

module.exports = { InputError, makeRequest, endpoint, normalize, toUsage, sse };
