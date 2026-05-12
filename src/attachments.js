'use strict';

/**
 * Attachment handling for OpenClaw Claude Bridge.
 *
 * Claude Code CLI does NOT support @/path image references in text-mode stdin
 * (--print without --input-format stream-json) — it interprets them as a request
 * to use the (disabled) Read tool. The path that works is:
 *
 *   1. Pass --input-format stream-json --output-format stream-json --verbose
 *   2. Feed stdin a JSON message in Anthropic Messages API shape:
 *        {type: "user", message: {role: "user", content: [
 *          {type: "text", text: "..."},
 *          {type: "image", source: {type: "base64", media_type: "image/png", data: "..."}},
 *          {type: "document", source: {type: "base64", media_type: "application/pdf", data: "..."}},
 *        ]}}
 *
 * Verified against Claude CLI v2.1.98 with both Haiku and Sonnet — image content
 * was correctly identified end-to-end. Originally implemented in
 * Kyzcreig/hermes-claude-bridge v0.1.0; ported here with env-var rename.
 *
 * This module:
 *   - inspects OpenAI content parts for non-text attachments
 *   - returns a structured payload the runClaude path uses to choose
 *     text-mode (no attachments, fast path) vs stream-json input mode
 *
 * Modes (controlled by env OPENCLAW_BRIDGE_ATTACHMENT_MODE):
 *   - "passthrough" (default): emit Anthropic content blocks via stream-json input
 *   - "describe": drop non-text parts entirely (caller is expected to have
 *     described them upstream, e.g. via OpenClaw's imageModel routing).
 *     Use this if you want to preserve the historical bridge behavior.
 *
 * Set OPENCLAW_BRIDGE_ATTACHMENT_MODE=describe to turn off native multimodal.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const MODE = process.env.OPENCLAW_BRIDGE_ATTACHMENT_MODE || 'passthrough';
const PER_TURN_CAP = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_PER_TURN_CAP) || 20;
const SESSION_BUDGET_MB = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_SESSION_BUDGET_MB) || 500;
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS) || 30000;
const DOWNLOAD_MAX_BYTES = parseInt(process.env.OPENCLAW_BRIDGE_ATTACHMENT_DOWNLOAD_MAX_BYTES) || 50 * 1024 * 1024;

// State dir for staging attachment bytes. OC bridge has no formal state dir
// convention; default to <repo>/state/attachments unless OPENCLAW_BRIDGE_STATE_DIR
// is set explicitly.
const STATE_DIR = process.env.OPENCLAW_BRIDGE_STATE_DIR
    || path.join(__dirname, '..', 'state');
const ATTACH_DIR = path.join(STATE_DIR, 'attachments');

try { fs.mkdirSync(ATTACH_DIR, { recursive: true }); } catch {}

class AttachmentBudgetError extends Error {
    constructor(message) { super(message); this.name = 'AttachmentBudgetError'; }
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const DOC_MIMES = new Set(['application/pdf']);  // CLI accepts PDF as "document"

function _checkSessionBudget() {
    try {
        const files = fs.readdirSync(ATTACH_DIR);
        let total = 0;
        for (const f of files) {
            try { total += fs.statSync(path.join(ATTACH_DIR, f)).size; } catch {}
        }
        const budgetBytes = SESSION_BUDGET_MB * 1024 * 1024;
        if (total > budgetBytes) {
            throw new AttachmentBudgetError(
                `session disk budget exceeded (${Math.round(total/1024/1024)} MB > ${SESSION_BUDGET_MB} MB)`
            );
        }
    } catch (err) {
        if (err instanceof AttachmentBudgetError) throw err;
    }
}

function _safeExt(name, fallback = 'bin') {
    if (!name) return fallback;
    const m = name.match(/\.([a-zA-Z0-9]{1,8})$/);
    return m ? m[1].toLowerCase() : fallback;
}

function _extFromMime(mime) {
    if (!mime) return null;
    const map = {
        'image/png': 'png',
        'image/jpeg': 'jpg', 'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'text/markdown': 'md',
        'application/json': 'json',
    };
    return map[mime.toLowerCase()] || null;
}

function _mimeFromExt(ext) {
    const map = {
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'webp': 'image/webp', 'gif': 'image/gif',
        'pdf': 'application/pdf',
        'txt': 'text/plain', 'md': 'text/markdown', 'json': 'application/json',
        'py': 'text/x-python', 'js': 'text/javascript', 'ts': 'text/typescript',
    };
    return map[(ext || '').toLowerCase()] || 'application/octet-stream';
}

function _parseDataUrl(url) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    const isBase64 = !!m[2];
    const payload = m[3];
    const buf = isBase64
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8');
    return { mime, buf };
}

function _downloadSync(url) {
    const tmp = path.join(ATTACH_DIR, `.dl-${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
        execFileSync('curl', [
            '-fsSL',
            '--max-time', String(Math.floor(DOWNLOAD_TIMEOUT_MS / 1000)),
            '--max-filesize', String(DOWNLOAD_MAX_BYTES),
            '-o', tmp,
            url,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        const buf = fs.readFileSync(tmp);
        return buf;
    } finally {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

/**
 * Resolve an OpenAI content part to {bytes, mime, name} or null if not an
 * attachment we handle. Used by classifyParts() to build Anthropic content
 * blocks.
 */
function _resolveAttachment(part) {
    let bytes = null;
    let mime = null;
    let name = null;

    if (part.type === 'image_url' || part.type === 'input_image') {
        const v = part.image_url;
        const url = typeof v === 'string' ? v : (v && v.url);
        if (!url) return null;

        if (url.startsWith('data:')) {
            const parsed = _parseDataUrl(url);
            if (!parsed) return null;
            bytes = parsed.buf; mime = parsed.mime;
        } else if (/^https?:\/\//i.test(url)) {
            bytes = _downloadSync(url);
            try {
                const u = new URL(url);
                name = path.basename(u.pathname);
                mime = _mimeFromExt(_safeExt(name));
            } catch {}
        } else if (url.startsWith('/') || url.startsWith('~') || url.startsWith('./')) {
            const abs = url.startsWith('~')
                ? path.join(process.env.HOME, url.slice(1))
                : path.resolve(url);
            if (!fs.existsSync(abs)) return null;
            bytes = fs.readFileSync(abs);
            name = path.basename(abs);
            mime = _mimeFromExt(_safeExt(name));
        } else {
            return null;
        }
        // Force to a known image mime if extension says so
        if (!IMAGE_MIMES.has((mime || '').toLowerCase())) {
            const fromName = _mimeFromExt(_safeExt(name));
            if (IMAGE_MIMES.has(fromName)) mime = fromName;
            else mime = mime || 'image/png';  // best-effort default
        }
    } else if (part.type === 'file') {
        const f = part.file || {};
        name = f.filename || f.name || null;
        if (f.file_data) {
            try { bytes = Buffer.from(f.file_data, 'base64'); } catch { return null; }
        } else if (f.file_url) {
            bytes = _downloadSync(f.file_url);
            if (!name) {
                try { name = path.basename(new URL(f.file_url).pathname); } catch {}
            }
        } else if (f.path) {
            const abs = path.resolve(f.path);
            if (!fs.existsSync(abs)) return null;
            bytes = fs.readFileSync(abs);
            if (!name) name = path.basename(abs);
        } else {
            return null;
        }
        const ext = _safeExt(name);
        mime = _mimeFromExt(ext);
    } else {
        return null;
    }

    if (!bytes) return null;
    return { bytes, mime, name };
}

/**
 * Given an OpenAI message's content (string or array of parts), classify it
 * into:
 *   - {text: string, attachments: [Anthropic content blocks]}
 *
 * In "passthrough" mode:
 *   - images → Anthropic image content blocks (base64)
 *   - PDFs → Anthropic document content blocks (base64)
 *   - other files (text/code) → inlined as fenced code blocks in the text segment
 *
 * In "describe" mode: all non-text parts are dropped (preserves legacy
 * imageModel-routing behavior).
 *
 * The caller decides whether the resulting message needs stream-json input
 * (has attachments) or can use plain text mode (no attachments).
 */
function classifyParts(content, turnId) {
    if (typeof content === 'string') {
        return { text: content, attachments: [] };
    }
    if (content === null || content === undefined) {
        return { text: '', attachments: [] };
    }
    if (!Array.isArray(content)) {
        return { text: String(content ?? ''), attachments: [] };
    }

    const textSegments = [];
    const attachments = [];
    let count = 0;

    for (const p of content) {
        if (!p || typeof p !== 'object') continue;
        if (p.type === 'text') {
            if (p.text) textSegments.push(p.text);
            continue;
        }
        if (MODE === 'describe') continue;

        if (++count > PER_TURN_CAP) {
            throw new AttachmentBudgetError(
                `per-turn cap exceeded (${count} > ${PER_TURN_CAP})`
            );
        }
        _checkSessionBudget();

        let resolved;
        try {
            resolved = _resolveAttachment(p);
        } catch (err) {
            console.warn(`[attachments] resolve failed: ${err.message}`);
            textSegments.push(`[attachment skipped: ${err.message}]`);
            continue;
        }
        if (!resolved) {
            textSegments.push('[attachment skipped: unrecognized format]');
            continue;
        }
        const { bytes, mime, name } = resolved;

        // Image → Anthropic image block
        if (IMAGE_MIMES.has((mime || '').toLowerCase())) {
            attachments.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: mime,
                    data: bytes.toString('base64'),
                },
            });
            continue;
        }
        // PDF → Anthropic document block
        if (DOC_MIMES.has((mime || '').toLowerCase())) {
            attachments.push({
                type: 'document',
                source: {
                    type: 'base64',
                    media_type: mime,
                    data: bytes.toString('base64'),
                },
            });
            continue;
        }
        // Text/code file → inline as fenced block in the text segment.
        // Cheap, lossless for the use cases (configs, source files, logs).
        // Also persist the file to state/attachments/ for debugging.
        try {
            const ext = _extFromMime(mime) || _safeExt(name, 'txt');
            const slug = `${turnId}-${count}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
            fs.writeFileSync(path.join(ATTACH_DIR, slug), bytes);
        } catch {}
        const lang = _safeExt(name, '');
        const asText = bytes.toString('utf8');
        const displayName = name || `attachment.${_extFromMime(mime) || 'bin'}`;
        textSegments.push(
            `\n[attached file: ${displayName}]\n\`\`\`${lang}\n${asText}\n\`\`\`\n`
        );
    }

    return {
        text: textSegments.join('\n'),
        attachments,
    };
}

module.exports = {
    classifyParts,
    AttachmentBudgetError,
    MODE,
};
