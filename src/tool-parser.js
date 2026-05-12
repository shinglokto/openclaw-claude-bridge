'use strict';

const { v4: uuidv4 } = require('uuid');

function normalizeJsonish(text) {
    let out = '';
    let inString = false;
    let escape = false;
    for (const ch of text) {
        if (escape) {
            out += ch;
            escape = false;
            continue;
        }
        if (ch === '\\') {
            out += ch;
            escape = true;
            continue;
        }
        if (ch === '"') {
            out += ch;
            inString = !inString;
            continue;
        }
        if (inString) {
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
        }
        out += ch;
    }
    return out;
}

function parseLooseJson(jsonText) {
    try {
        return { parsed: JSON.parse(jsonText), recovered: false };
    } catch (firstErr) {
        const normalized = normalizeJsonish(jsonText);
        if (normalized !== jsonText) {
            try {
                return { parsed: JSON.parse(normalized), recovered: true };
            } catch {}
        }
        throw firstErr;
    }
}

function isAllowedToolName(name, allowedToolNames) {
    if (!allowedToolNames || allowedToolNames.size === 0) return true;
    return allowedToolNames.has(name);
}

function coerceToolCall(raw, allowedToolNames) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
        return { error: 'no_json_object', preview: raw.slice(0, 300) };
    }
    const jsonText = raw.slice(start, end + 1);
    try {
        const { parsed, recovered } = parseLooseJson(jsonText);
        if (!parsed || typeof parsed.name !== 'string') {
            return { error: 'invalid_payload', preview: jsonText.slice(0, 300) };
        }
        if (!isAllowedToolName(parsed.name, allowedToolNames)) {
            return { error: 'tool_not_allowed', name: parsed.name, preview: jsonText.slice(0, 300) };
        }
        const args = (parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments))
            ? parsed.arguments
            : {};
        return {
            call: {
                id: `call_${uuidv4().slice(0, 8)}`,
                name: parsed.name,
                arguments: args,
            },
            recovered,
        };
    } catch {
        return { error: 'json_parse_failed', preview: jsonText.slice(0, 300) };
    }
}

function extractBalancedJsonObjects(text) {
    const objects = [];
    let inString = false;
    let escape = false;
    let depth = 0;
    let start = -1;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (ch === '}') {
            if (depth === 0) continue;
            depth -= 1;
            if (depth === 0 && start !== -1) {
                objects.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    return objects;
}

function parseExactToolCalls(text, allowedToolNames) {
    const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    const calls = [];
    const errors = [];
    let recoveredJson = false;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const raw = (match[1] || '').trim();
        const result = coerceToolCall(raw, allowedToolNames);
        if (result.call) {
            calls.push(result.call);
            if (result.recovered) recoveredJson = true;
        } else {
            errors.push(result);
        }
    }
    return { calls, errors, recoveredJson };
}

function parseMalformedToolCall(text, allowedToolNames) {
    const opens = [...text.matchAll(/<tool_call\b[^>]*>/g)];
    if (opens.length !== 1) {
        return { calls: [], repaired: false, reason: opens.length === 0 ? 'no_markup' : 'multiple_tool_call_blocks' };
    }

    const open = opens[0];
    const bodyStart = open.index + open[0].length;
    const tail = text.slice(bodyStart);
    const closeCandidates = ['</tool_call>', '</tool_char>']
        .map(tag => ({ tag, idx: tail.indexOf(tag) }))
        .filter(c => c.idx !== -1)
        .sort((a, b) => a.idx - b.idx);
    const bodyEnd = closeCandidates.length > 0 ? closeCandidates[0].idx : tail.length;
    const raw = tail.slice(0, bodyEnd).trim();
    const jsonObjects = extractBalancedJsonObjects(raw);
    if (jsonObjects.length !== 1) {
        return { calls: [], repaired: false, reason: `json_object_count_${jsonObjects.length}` };
    }

    const result = coerceToolCall(jsonObjects[0], allowedToolNames);
    if (!result.call) {
        return { calls: [], repaired: false, reason: result.error, error: result };
    }
    return { calls: [result.call], repaired: true, closeTag: closeCandidates[0]?.tag || 'EOF', recoveredJson: result.recovered };
}

function parseToolCallsDetailed(text, opts = {}) {
    const source = String(text || '');
    const allowedToolNames = opts.allowedToolNames || null;
    const hadToolCallMarkup = /<tool_call\b/i.test(source);

    const exact = parseExactToolCalls(source, allowedToolNames);
    if (exact.calls.length > 0) {
        return { calls: exact.calls, repaired: false, hadToolCallMarkup, errors: exact.errors, recoveredJson: exact.recoveredJson };
    }

    if (!hadToolCallMarkup) {
        return { calls: [], repaired: false, hadToolCallMarkup: false, errors: exact.errors };
    }

    const malformed = parseMalformedToolCall(source, allowedToolNames);
    return {
        calls: malformed.calls,
        repaired: malformed.repaired,
        hadToolCallMarkup,
        malformedReason: malformed.reason,
        closeTag: malformed.closeTag,
        errors: exact.errors.concat(malformed.error ? [malformed.error] : []),
        recoveredJson: !!malformed.recoveredJson,
    };
}

function parseToolCalls(text, allowedToolNames) {
    return parseToolCallsDetailed(text, { allowedToolNames }).calls;
}

function hasInternalBridgeMarkup(text) {
    if (!text) return false;
    return /<(?:tool_call|tool_result|tool_thinking|previous_response)\b|<\/(?:tool_call|tool_char|tool_result|tool_thinking|previous_response)>/i.test(String(text));
}

function redactSensitivePreview(text, maxLen = 400) {
    if (!text) return '';
    return String(text)
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
        .replace(/\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|DEEPSEEK_API_KEY)\b\s*[:=]\s*[^\s"']+/gi, '$1=***')
        .replace(/\b(token|api[_-]?key|secret|password)\b\s*[:=]\s*[^\s,}\]"']+/gi, '$1=***')
        .slice(0, maxLen)
        .replace(/\n/g, '\\n');
}

function cleanResponseText(text) {
    if (!text) return text;
    const stripped = String(text)
        .replace(/<tool_thinking\b[^>]*>[\s\S]*?<\/tool_thinking>/g, '')
        .replace(/<tool_call\b[^>]*>[\s\S]*?<\/(?:tool_call|tool_char)>/g, '')
        .replace(/<tool_call\b[^>]*>[\s\S]*$/g, '')
        .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/g, '')
        .replace(/<previous_response\b[^>]*>[\s\S]*?<\/previous_response>/g, '')
        .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_result>/g, '')
        .replace(/<tool_thinking\b[^>]*>[\s\S]*?<\/tool_call>/g, '')
        .replace(/<tool_thinking\b[^>]*>[\s\S]*?<\/tool_result>/g, '')
        .replace(/<\/?(?:tool_thinking|tool_call|tool_result|previous_response)\b[^>]*>/g, '');
    const parts = stripped.split(/(```[\s\S]*?```)/);
    return parts
        .map((part, idx) => idx % 2 === 0 ? part.replace(/\n{3,}/g, '\n\n') : part)
        .join('')
        .trim();
}

module.exports = {
    cleanResponseText,
    extractBalancedJsonObjects,
    hasInternalBridgeMarkup,
    parseToolCalls,
    parseToolCallsDetailed,
    redactSensitivePreview,
};
