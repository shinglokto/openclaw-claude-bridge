'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { convertMessages, convertMessagesCompact, extractNewMessages, extractNewUserMessages } = require('./convert');
const { buildToolInstructions } = require('./tools');
const { runClaude, getContextWindow, clearSessionAlias } = require('./claude');
const { cleanResponseText, hasInternalBridgeMarkup, parseToolCallsDetailed, redactSensitivePreview } = require('./tool-parser');

// --- Session cleanup ---
// Claude CLI subprocess runs with cwd=/tmp. On macOS /tmp → /private/tmp,
// so Claude CLI creates sessions in -private-tmp instead of -tmp.
// Use fs.realpathSync to resolve the symlink and match what Claude CLI does.
const SESSIONS_DIR = path.join(
    process.env.HOME,
    '.claude/projects',
    '-' + fs.realpathSync('/tmp').replace(/\//g, '-').replace(/^-/, '')
);
const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

function cleanupSessions(maxAgeMs = CLEANUP_MAX_AGE_MS) {
    try {
        if (!fs.existsSync(SESSIONS_DIR)) return { deleted: 0, remaining: 0 };
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
        const cutoff = Date.now() - maxAgeMs;
        let deleted = 0;
        for (const file of files) {
            const fp = path.join(SESSIONS_DIR, file);
            try {
                const stat = fs.statSync(fp);
                if (stat.mtimeMs < cutoff) { fs.unlinkSync(fp); deleted++; }
            } catch {}
        }
        const remaining = files.length - deleted;
        return { deleted, remaining };
    } catch { return { deleted: 0, remaining: 0, error: 'failed' }; }
}

// Cache session info to avoid sync I/O on every dashboard poll
let _sessionCache = { data: { count: 0, sizeKB: 0 }, ts: 0 };
function getSessionInfo() {
    if (Date.now() - _sessionCache.ts < 10000) return _sessionCache.data; // 10s TTL
    try {
        if (!fs.existsSync(SESSIONS_DIR)) { _sessionCache = { data: { count: 0, sizeKB: 0 }, ts: Date.now() }; return _sessionCache.data; }
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
        let totalSize = 0;
        for (const file of files) {
            try { totalSize += fs.statSync(path.join(SESSIONS_DIR, file)).size; } catch {}
        }
        _sessionCache = { data: { count: files.length, sizeKB: Math.round(totalSize / 1024) }, ts: Date.now() };
        return _sessionCache.data;
    } catch { return { count: 0, sizeKB: 0 }; }
}

// Auto-cleanup on startup
const startupCleanup = cleanupSessions();
if (startupCleanup.deleted > 0) {
    console.log(`[openclaw-claude-bridge] Startup cleanup: deleted ${startupCleanup.deleted} old sessions, ${startupCleanup.remaining} remaining`);
}

// --- Persistence ---
const STATE_FILE = path.join(__dirname, '..', 'state.json');

function saveState() {
    try {
        const data = {
            stats: { totalRequests: stats.totalRequests, errors: stats.errors },
            channelMap: Array.from(channelMap.entries()),
            responseMap: Array.from(responseMap.entries()),
            requestLog,
            globalActivity,
        };
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
        console.warn(`[persist] Failed to save state: ${err.message}`);
    }
}

/** Check if a CLI session file still exists on disk. */
function sessionFileExists(sessionId) {
    return fs.existsSync(path.join(SESSIONS_DIR, `${sessionId}.jsonl`));
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

        // Restore stats (cumulative counters only)
        if (data.stats) {
            stats.totalRequests = data.stats.totalRequests || 0;
            stats.errors = data.stats.errors || 0;
        }

        // Restore channelMap — only if CLI session file still exists
        let restored = 0, pruned = 0;
        if (data.channelMap) {
            for (const [key, val] of data.channelMap) {
                if (sessionFileExists(val.sessionId)) {
                    channelMap.set(key, val);
                    restored++;
                } else {
                    pruned++;
                }
            }
        }

        // Restore responseMap — only if CLI session file still exists
        if (data.responseMap) {
            for (const [key, val] of data.responseMap) {
                if (sessionFileExists(val.sessionId)) {
                    responseMap.set(key, val);
                }
            }
        }

        // Restore requestLog
        if (data.requestLog) {
            requestLog.push(...data.requestLog.slice(-MAX_LOG));
        }

        // Restore globalActivity
        if (data.globalActivity) {
            globalActivity.push(...data.globalActivity.slice(-MAX_ACTIVITY));
        }

        console.log(`[persist] Loaded: ${restored} channels, ${pruned} pruned (session gone), ${requestLog.length} log entries, ${globalActivity.length} activity`);
    } catch (err) {
        console.warn(`[persist] Failed to load state: ${err.message}`);
    }
}

// --- Shared state ---
const stats = {
    startedAt: new Date(),
    totalRequests: 0,
    activeRequests: 0,
    lastRequestAt: null,
    lastModel: null,
    errors: 0,
};

// --- Session reuse tracking ---
// Primary: Maps OC conversation label → { sessionId, createdAt }
const channelMap = new Map();
// Maps tool_call_id → { sessionId, createdAt } for tool loop resume
const sessionMap = new Map();
// Maps response content key → { sessionId, createdAt } for non-tool-call resume (fallback for DMs)
const responseMap = new Map();
// Memory cleanup TTL (not for session lifecycle — just garbage collection)
const MEMORY_GC_TTL_MS = 60 * 60 * 1000; // 1 hour

// Per-channel concurrent request limit (prevents bug loops while allowing multi-channel usage)
const MAX_PER_CHANNEL = parseInt(process.env.MAX_PER_CHANNEL) || 2;
const MAX_GLOBAL = parseInt(process.env.MAX_GLOBAL) || 20;
const channelActive = new Map(); // channel → count of in-flight requests

/** First 200 chars of text as a lookup key. */
function contentKey(text) {
    if (!text) return null;
    return text.slice(0, 200);
}

/**
 * Extract OC conversation label from messages.
 * Looks for "Conversation info (untrusted metadata)" JSON block in user messages.
 * Returns the conversation_label string, or null if not found (e.g. DMs).
 */
function extractConversationLabel(messages) {
    for (const msg of messages) {
        if (msg.role !== 'user') continue;
        const content = typeof msg.content === 'string' ? msg.content
            : Array.isArray(msg.content) ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
            : '';
        const match = content.match(/Conversation info \(untrusted metadata\):\s*```json\s*(\{[\s\S]*?\})\s*```/);
        if (match) {
            try {
                const meta = JSON.parse(match[1]);
                // Use conversation_label for group chats, fall back to sender for DMs
                return meta.conversation_label || (meta.sender ? `dm:${meta.sender}` : null);
            } catch {}
        }
    }
    return null;
}

/**
 * Extract agent name from developer/system messages.
 * OC includes the agent's IDENTITY.md in the system prompt, which contains "**Name:** AgentName".
 * Returns the agent name string, or null if not found.
 */
function extractAgentName(messages) {
    for (const msg of messages) {
        if (msg.role !== 'developer' && msg.role !== 'system') continue;
        const text = typeof msg.content === 'string' ? msg.content
            : Array.isArray(msg.content) ? msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n')
            : '';
        const match = text.match(/\*\*Name:\*\*\s*(.+)/);
        if (match) {
            const name = match[1].trim();
            if (name && !name.startsWith('_')) return name;
        }
    }
    return null;
}

function messageText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter(p => p && (p.type === 'text' || typeof p.text === 'string'))
            .map(p => p.text || '')
            .join('\n');
    }
    return '';
}

/**
 * OpenClaw sometimes asks the configured model for a short session filename slug.
 * That request can include Discord metadata and tools, so if it is proxied into a
 * per-channel Claude CLI session it poisons the channel: future real prompts resume
 * a title-generation conversation and Claude replies with the slug forever.
 * Intercept it before session routing and do not store channelMap/responseMap state.
 */
function isSessionTitleSlugRequest(messages) {
    return messages.some((msg) => {
        if (msg.role !== 'user') return false;
        const text = messageText(msg).trim();
        return /^(?:User:\s*)?Based on this conversation, generate a short 1-2 word filename slug\b/i.test(text)
            || /generate a short 1-2 word filename slug \(lowercase, hyphen-separated, no file extension\)/i.test(text);
    });
}

/**
 * Detect if this is a new OC session (has "✅ New session started" marker
 * as the FIRST assistant/previous_response content, with no other assistant messages we recognise).
 */

/**
 * Clean up all in-memory entries belonging to a specific CLI session.
 * Also delete the CLI session file from disk.
 */
function purgeCliSession(cliSessionId) {
    clearSessionAlias(cliSessionId);
    // Clean sessionMap
    for (const [key, val] of sessionMap) {
        if (val.sessionId === cliSessionId) sessionMap.delete(key);
    }
    // Clean responseMap
    for (const [key, val] of responseMap) {
        if (val.sessionId === cliSessionId) responseMap.delete(key);
    }
    // Delete CLI session file
    const sessionFile = path.join(SESSIONS_DIR, `${cliSessionId}.jsonl`);
    try {
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            console.log(`[session] Purged old CLI session file: ${cliSessionId}`);
        }
    } catch (err) {
        console.warn(`[session] Failed to delete session file ${cliSessionId}: ${err.message}`);
    }
}

/** Garbage-collect orphaned in-memory entries older than MEMORY_GC_TTL_MS. */
function gcMemory() {
    const cutoff = Date.now() - MEMORY_GC_TTL_MS;
    for (const [key, val] of sessionMap) {
        if (val.createdAt < cutoff) sessionMap.delete(key);
    }
    for (const [key, val] of responseMap) {
        if (val.createdAt < cutoff) responseMap.delete(key);
    }
}

// Circular buffer: last 200 requests
const MAX_LOG = 200;
const requestLog = [];
function pushLog(entry) {
    requestLog.push(entry);
    if (requestLog.length > MAX_LOG) requestLog.shift();
}

// Live activity feed (global, last 50 messages)
const MAX_ACTIVITY = 50;
const globalActivity = [];
function pushActivity(requestId, msg) {
    globalActivity.push({ id: requestId, at: Date.now(), msg });
    if (globalActivity.length > MAX_ACTIVITY) globalActivity.shift();
}

// Load persisted state (channelMap, responseMap, requestLog, stats, globalActivity)
loadState();

// Tool-call parsing and internal bridge markup cleanup live in ./tool-parser.

// ─── API app (port 3456, localhost only) ──────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'openclaw-claude-bridge' });
});

app.get('/v1/models', (req, res) => {
    res.json({
        object: 'list',
        data: [
            { id: 'claude-opus-4-7',   object: 'model', created: 1700000000, owned_by: 'anthropic' },
            { id: 'claude-opus-4-6',   object: 'model', created: 1700000000, owned_by: 'anthropic' },
            { id: 'claude-sonnet-4-6', object: 'model', created: 1700000000, owned_by: 'anthropic' },
            { id: 'claude-haiku-4-5',  object: 'model', created: 1700000000, owned_by: 'anthropic' },
        ],
    });
});

app.post('/v1/chat/completions', async (req, res) => {
    const requestId = uuidv4().slice(0, 8);
    const startTime = Date.now();

    stats.totalRequests++;
    stats.activeRequests++;
    stats.lastRequestAt = new Date();
    let acquiredChannel = null; // routingKey if channelActive was incremented

    console.log(`[${requestId}] POST /v1/chat/completions`);
    // Debug: log OC session identifiers
    const ocSessionKey = req.headers['x-openclaw-session-key'] || null;
    const ocUser = req.body?.user || null;
    if (ocSessionKey || ocUser) {
        console.log(`[${requestId}] OC identifiers: session-key=${ocSessionKey} user=${ocUser}`);
    }

    const logEntry = {
        id: requestId,
        at: new Date().toISOString(),
        model: null,
        tools: 0,
        promptLen: 0,
        inputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        durationMs: null,
        status: 'pending',
        error: null,
        activity: [],
        cliSessionId: null,
        resumed: false,
        channel: null,
        effort: null,
        thinking: false,
        resumeMethod: null,
    };
    pushLog(logEntry); // appear in dashboard immediately as 'pending'

    try {
        const { messages = [], tools = [], model = 'claude-opus-4-7', stream = true, reasoning_effort, user } = req.body;
        stats.lastModel = model;
        logEntry.model = model;
        logEntry.contextWindow = getContextWindow(model);
        logEntry.tools = tools.length;
        logEntry.effort = reasoning_effort || null;
        logEntry.thinking = !!reasoning_effort;
        if (reasoning_effort) console.log(`[${requestId}] reasoning_effort=${reasoning_effort}`);

        if (isSessionTitleSlugRequest(messages)) {
            const promptLen = messages.reduce((s, m) => s + messageText(m).length, 0);
            console.warn(`[${requestId}] SESSION TITLE intercepted: tools=${tools.length} promptLen≈${promptLen}, returning NO_REPLY without session routing`);
            logEntry.status = 'ok';
            logEntry.resumeMethod = 'session_title_intercept';
            logEntry.promptLen = promptLen;
            logEntry.durationMs = Date.now() - startTime;
            pushActivity(requestId, '🏷️ session title intercepted');
            return res.json({
                id: `chatcmpl-${requestId}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'NO_REPLY' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
        }

        const allowedToolNames = new Set(tools.map(t => t.function?.name || t.name).filter(Boolean));
        if (tools.length > 0) {
            const toolNames = Array.from(allowedToolNames);
            console.log(`[${requestId}] tools:[${toolNames.join(',')}]`);
        }

        // Memory flush interception: OC sends tools=0 before compaction, no need to proxy to CLI
        if (tools.length === 0) {
            const promptLen = messages.reduce((s, m) => s + JSON.stringify(m.content || '').length, 0);
            const mfChannel = extractConversationLabel(messages);
            const mfAgent = extractAgentName(messages);
            logEntry.channel = mfChannel ? mfChannel.replace(/^Guild\s+/, '').slice(0, 30) : null;
            logEntry.agent = mfAgent || null;
            console.log(`[${requestId}] MEMORY FLUSH intercepted: tools=0 channel="${mfChannel}" agent="${mfAgent}" promptLen≈${promptLen}, returning NO_REPLY`);
            logEntry.status = 'ok';
            logEntry.resumeMethod = 'memflush';
            logEntry.promptLen = promptLen;
            logEntry.durationMs = Date.now() - startTime;
            pushActivity(requestId, `🧹 memflush intercepted (${Math.round(promptLen/1000)}K chars)`);
            return res.json({
                id: `chatcmpl-${requestId}`,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, message: { role: 'assistant', content: 'NO_REPLY' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
        }

        // OC /new startup requests now surface user-visible failures if we return a synthetic
        // empty stop payload here. Let them flow through to Claude so Forge gets a real first turn.

        // --- Session reuse detection ---
        gcMemory();
        let isResume = false;
        let resumeSessionId = null;

        // Extract conversation identity.
        // Priority:
        // 1. OpenClaw-style conversation metadata + agent name, for multi-agent channels.
        // 2. OpenAI-compatible `user` field, for OpenAI clients and raw API tests.
        // Without the `user` fallback, plain OpenAI requests never hit channelMap and
        // every turn starts a fresh Claude CLI session.
        const convLabel = extractConversationLabel(messages);
        const agentName = extractAgentName(messages);
        const openAiUser = typeof user === 'string' && user.trim() ? user.trim() : null;
        const routingKey = convLabel
            ? (agentName ? `${convLabel}::${agentName}` : convLabel)
            : (openAiUser ? `openai-user:${openAiUser}` : null);
        if (routingKey) {
            console.log(`[${requestId}] OC channel: "${convLabel}" agent: "${agentName || '(none)'}" routingKey: "${routingKey}"`);
        }

        // --- Per-channel and global concurrent limits ---
        if (stats.activeRequests > MAX_GLOBAL) {
            console.warn(`[${requestId}] BLOCKED: global limit (${MAX_GLOBAL} concurrent)`);
            logEntry.status = 'error';
            logEntry.error = 'Global concurrent limit';
            return res.status(429).json({ error: { message: `Too many concurrent requests (max ${MAX_GLOBAL})`, type: 'rate_limit' } });
        }
        if (routingKey) {
            const active = channelActive.get(routingKey) || 0;
            if (active >= MAX_PER_CHANNEL) {
                console.warn(`[${requestId}] BLOCKED: "${routingKey}" has ${active} in-flight (max ${MAX_PER_CHANNEL})`);
                logEntry.status = 'error';
                logEntry.error = 'Per-channel concurrent limit';
                return res.status(429).json({ error: { message: `Too many concurrent requests for this channel (max ${MAX_PER_CHANNEL})`, type: 'rate_limit' } });
            }
            channelActive.set(routingKey, active + 1);
            acquiredChannel = routingKey;
        }

        // 1) Check channelMap (primary: OC conversation → CLI session)
        if (!isResume && routingKey && channelMap.has(routingKey)) {
            resumeSessionId = channelMap.get(routingKey).sessionId;
            isResume = true;
            console.log(`[${requestId}] channelMap hit: "${routingKey}" → session=${resumeSessionId.slice(0, 8)}`);
        }
        // Detect /new after channelMap hit: if the first assistant message is the
        // "New session started" marker and there are NO other assistant messages
        // (bridge hasn't replied yet), this is the first request after /new.
        if (isResume && routingKey && channelMap.has(routingKey)) {
            const assistantMsgs = messages.filter(m => m.role === 'assistant');
            if (assistantMsgs.length === 1) {
                const c = typeof assistantMsgs[0].content === 'string' ? assistantMsgs[0].content
                    : Array.isArray(assistantMsgs[0].content) ? assistantMsgs[0].content.filter(p => p.type === 'text').map(p => p.text).join('') : '';
                if (c.includes('New session started')) {
                    console.log(`[${requestId}] /new detected after channelMap hit: purging old session=${resumeSessionId.slice(0, 8)}`);
                    purgeCliSession(resumeSessionId);
                    channelMap.delete(routingKey);
                    isResume = false;
                    resumeSessionId = null;
                }
            }
        }
        // 2) Check tool_call_ids (tool loop continuation)
        if (!isResume) {
            for (const msg of messages) {
                if (msg.role === 'tool' && msg.tool_call_id && sessionMap.has(msg.tool_call_id)) {
                    resumeSessionId = sessionMap.get(msg.tool_call_id).sessionId;
                    isResume = true;
                    break;
                }
            }
        }
        // 3) Check assistant response content (fallback for DMs or missing label)
        if (!isResume) {
            for (const msg of messages) {
                if (msg.role === 'assistant') {
                    let text = msg.content;
                    if (Array.isArray(text)) {
                        text = text.filter(p => p.type === 'text').map(p => p.text).join('\n');
                    }
                    const key = contentKey(typeof text === 'string' ? text : null);
                    if (key && responseMap.has(key)) {
                        resumeSessionId = responseMap.get(key).sessionId;
                        isResume = true;
                        console.log(`[${requestId}] responseMap hit: key="${key.slice(0, 50)}..." → session=${resumeSessionId.slice(0, 8)}`);
                        break;
                    }
                }
            }
            if (!isResume && messages.some(m => m.role === 'assistant')) {
                const assistantKeys = messages.filter(m => m.role === 'assistant').map(m => {
                    let t = m.content;
                    if (Array.isArray(t)) t = t.filter(p => p.type === 'text').map(p => p.text).join('\n');
                    return contentKey(typeof t === 'string' ? t : null);
                }).filter(Boolean);
                console.log(`[${requestId}] responseMap miss: tried ${assistantKeys.length} keys, map size=${responseMap.size}`);
                if (assistantKeys.length > 0) console.log(`[${requestId}]   first key: "${assistantKeys[0].slice(0, 60)}..."`);
            }
        }

        // Context refresh: detect OC compaction via summary hash → sync CLI
        if (isResume && routingKey && channelMap.has(routingKey)) {
            const COMPACTION_PREFIX = 'The conversation history before this point was compacted into the following summary:';
            let compactionHash = null;
            for (const m of messages) {
                if (m.role !== 'user') continue;
                const text = typeof m.content === 'string' ? m.content
                    : Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text || '').join('') : '';
                if (text.startsWith(COMPACTION_PREFIX)) {
                    const snippet = text.slice(0, 500);
                    let h = 0;
                    for (let i = 0; i < snippet.length; i++) { h = ((h << 5) - h + snippet.charCodeAt(i)) | 0; }
                    compactionHash = h;
                    break;
                }
            }

            const entry = channelMap.get(routingKey);
            const lastHash = entry?.lastCompactionHash ?? null;

            if (compactionHash !== null && compactionHash !== lastHash) {
                const inToolLoop = extractNewMessages(messages) !== null;
                if (!inToolLoop) {
                    const compactResult = convertMessagesCompact(messages);
                    if (compactResult.promptText.length > 1500000) {
                        console.log(`[${requestId}] REFRESH SKIPPED: compact prompt too long (${compactResult.promptText.length})`);
                    } else {
                        const oldSid = entry.sessionId;
                        console.log(`[${requestId}] CONTEXT REFRESH (hash=${compactionHash}): ${oldSid.slice(0, 8)} → new session (compact ${compactResult.promptText.length} chars)`);
                        logEntry.resumeMethod = 'refresh';
                        logEntry.refreshPrompt = compactResult.promptText;
                        logEntry.refreshSystemPrompt = compactResult.systemPrompt;
                        logEntry.refreshAttachmentBlocks = compactResult.attachmentBlocks || [];
                        logEntry.pendingCompactionHash = compactionHash;
                        purgeCliSession(oldSid);
                        channelMap.delete(routingKey);
                        isResume = false;
                        resumeSessionId = null;
                    }
                } else {
                    console.log(`[${requestId}] REFRESH DEFERRED: tool loop in progress (hash=${compactionHash})`);
                }
            }
        }

        let promptText;
        let combinedSystemPrompt;
        let sessionId;
        let attachmentBlocks = [];

        // Always build system prompt (not persisted in CLI session)
        const { systemPrompt: devSystemPrompt } = convertMessages(messages);
        const toolInstructions = buildToolInstructions(tools);
        combinedSystemPrompt = devSystemPrompt
            ? `${devSystemPrompt}${toolInstructions}`
            : toolInstructions || undefined;

        if (isResume) {
            // Resume mode: only send new messages as prompt
            sessionId = resumeSessionId;
            // 1) Try tool loop extraction (messages after last assistant tool_calls)
            const newToolLoop = extractNewMessages(messages);
            // 2) Try conversation continuation (messages after last assistant message)
            const newCont = !newToolLoop ? extractNewUserMessages(messages) : null;
            if (newToolLoop) {
                promptText = newToolLoop.newText;
                attachmentBlocks = newToolLoop.attachmentBlocks || [];
                logEntry.resumeMethod = 'tool_loop';
                console.log(`[${requestId}] RESUME session=${sessionId.slice(0, 8)} newPromptLen=${promptText.length} (tool loop)${attachmentBlocks.length ? ` +${attachmentBlocks.length} attachment(s)` : ''}`);
                pushActivity(requestId, `🔄 resuming session (${promptText.length} chars new)`);
            } else if (newCont) {
                promptText = newCont.newText;
                attachmentBlocks = newCont.attachmentBlocks || [];
                logEntry.resumeMethod = 'continuation';
                console.log(`[${requestId}] RESUME session=${sessionId.slice(0, 8)} newPromptLen=${promptText.length} (continuation)${attachmentBlocks.length ? ` +${attachmentBlocks.length} attachment(s)` : ''}`);
                pushActivity(requestId, `🔄 resuming session (${promptText.length} chars new)`);
            } else if (routingKey && !messages.some(m => m.role === 'assistant')) {
                // OpenAI-compatible clients often send only the latest user message
                // while relying on the `user` routing key for continuity. In that
                // shape there is no assistant anchor for extractNewUserMessages(),
                // but we still should resume the mapped Claude CLI session and send
                // the current user turn.
                const full = convertMessages(messages);
                promptText = full.promptText;
                attachmentBlocks = full.attachmentBlocks || [];
                logEntry.resumeMethod = 'user_key_continuation';
                console.log(`[${requestId}] RESUME session=${sessionId.slice(0, 8)} promptLen=${promptText.length} (user key continuation)`);
                pushActivity(requestId, `🔄 resuming session (${promptText.length} chars via user key)`);
            } else {
                // Fallback: nothing new to send, use full history as new session
                logEntry.resumeMethod = 'fallback';
                isResume = false;
                sessionId = uuidv4();
                const full = convertMessages(messages);
                promptText = full.promptText;
                attachmentBlocks = full.attachmentBlocks || [];
                console.log(`[${requestId}] RESUME fallback → new session=${sessionId.slice(0, 8)}`);
                pushActivity(requestId, `⏳ thinking... (${tools.length} tools) [resume fallback]`);
            }
        } else {
            // New session (or refresh)
            sessionId = uuidv4();
            if (logEntry.refreshPrompt) {
                promptText = logEntry.refreshPrompt;
                const refreshSys = logEntry.refreshSystemPrompt;
                if (refreshSys) {
                    combinedSystemPrompt = `${refreshSys}${toolInstructions}`;
                }
                attachmentBlocks = logEntry.refreshAttachmentBlocks || [];
                delete logEntry.refreshPrompt;
                delete logEntry.refreshSystemPrompt;
                delete logEntry.refreshAttachmentBlocks;
                console.log(`[${requestId}] NEW session=${sessionId.slice(0, 8)} (context refresh)`);
                pushActivity(requestId, `🔄 context refresh → new session (${promptText.length} chars)`);
            } else {
                const full = convertMessages(messages);
                promptText = full.promptText;
                attachmentBlocks = full.attachmentBlocks || [];
                console.log(`[${requestId}] NEW session=${sessionId.slice(0, 8)}`);
                pushActivity(requestId, `⏳ thinking... (${tools.length} tools)`);
            }
        }

        logEntry.promptLen = promptText.length;
        logEntry.cliSessionId = sessionId.slice(0, 8);
        logEntry.resumed = isResume;
        logEntry.channel = convLabel ? convLabel.replace(/^Guild\s+/, '').slice(0, 30) : null;
        logEntry.agent = agentName || null;
        console.log(`[${requestId}] model=${model} tools=${tools.length} promptLen=${promptText.length} resume=${isResume}`);

        const isStream = stream !== false;
        if (isStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();
        }

        const completionId = `chatcmpl-${requestId}`;
        let chunksSent = 0;
        let accumulatedText = '';

        const sendChunk = (delta, finishReason = null) => {
            const chunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: finishReason ? {} : { role: 'assistant', content: delta }, finish_reason: finishReason }],
            };
            if (isStream) { res.write(`data: ${JSON.stringify(chunk)}\n\n`); chunksSent++; }
        };

        // Progress: logged server-side + captured for dashboard (not streamed to client)
        const onChunk = (text) => {
            const msg = text.trim();
            if (!msg) return;

            console.log(`[${requestId}] ${msg}`);
            logEntry.activity.push(msg);
            pushActivity(requestId, msg);
        };

        // Abort signal: kill Claude CLI when client disconnects before response is sent
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableFinished) ac.abort(); });

        let finalText;
        let finalUsage = { input_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0, output_tokens: 0, cost_usd: 0 };
        try {
            ({ text: finalText, usage: finalUsage } = await runClaude(combinedSystemPrompt, promptText, model, onChunk, ac.signal, reasoning_effort, sessionId, isResume, attachmentBlocks));
        } catch (err) {
            const errMessage = err?.message || 'Unknown Claude error';
            const emptyCompletion = /empty response/i.test(errMessage);
            const terminatedCompletion = /(^|\b)terminated(\b|$)/i.test(errMessage);
            const retryableFreshFailure = emptyCompletion || terminatedCompletion;
            const wasResume = isResume;

            // OC disconnected (timeout/restart) — not a CLI error, preserve session
            if (wasResume && errMessage === 'Client disconnected') {
                console.log(`[${requestId}] OC disconnected, preserving session=${sessionId.slice(0, 8)}`);
                logEntry.status = 'oc_disconnect';
                logEntry.error = errMessage;
                logEntry.durationMs = Date.now() - startTime;
                return;
            }

            // Retry resume failures with compact refresh, and retry empty/terminated
            // fresh-session failures once from a new Claude session.
            if (wasResume || retryableFreshFailure) {
                const retryLabel = wasResume ? 'compact refresh' : 'fresh session retry';
                if (retryableFreshFailure) {
                    const breadcrumb = terminatedCompletion ? '⚠ terminated_completion_retry' : '⚠ empty_completion_retry';
                    const breadcrumbLog = terminatedCompletion ? 'terminated_completion_retry' : 'empty_completion_retry';
                    console.warn(`[${requestId}] ${breadcrumbLog}: ${errMessage}`);
                    pushActivity(requestId, breadcrumb);
                    logEntry.activity.push(breadcrumb);
                }
                console.warn(`[${requestId}] Claude failed (${errMessage}), retrying with ${retryLabel}`);
                pushActivity(requestId, `⚠ Claude failed, retrying with ${retryLabel}`);
                logEntry.activity.push(`⚠ Claude failed: ${errMessage}`);
                isResume = false;
                sessionId = uuidv4();
                logEntry.resumeMethod = wasResume ? 'refresh' : (terminatedCompletion ? 'retry_terminated' : 'retry_empty');
                if (wasResume) {
                    const compactResult = convertMessagesCompact(messages);
                    promptText = compactResult.promptText;
                    if (compactResult.systemPrompt) {
                        combinedSystemPrompt = `${compactResult.systemPrompt}${toolInstructions}`;
                    }
                    attachmentBlocks = compactResult.attachmentBlocks || [];
                }
                logEntry.promptLen = promptText.length;
                console.log(`[${requestId}] Retry path: new session=${sessionId.slice(0, 8)} promptLen=${promptText.length}`);
                try {
                    ({ text: finalText, usage: finalUsage } = await runClaude(combinedSystemPrompt, promptText, model, onChunk, ac.signal, reasoning_effort, sessionId, false, attachmentBlocks));
                } catch (retryErr) {
                    console.error(`[${requestId}] Retry also failed: ${retryErr.message}`);
                    logEntry.status = 'error';
                    logEntry.error = retryErr.message;
                    if (isStream) {
                        sendChunk(`\n\n[Error: ${retryErr.message}]`);
                        sendChunk('', 'stop');
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        res.status(500).json({ error: { message: retryErr.message, type: 'internal_error' } });
                    }
                    return;
                }
            } else {
                console.error(`[${requestId}] Claude error: ${errMessage}`);
                logEntry.status = 'error';
                logEntry.error = errMessage;
                if (isStream) {
                    sendChunk(`\n\n[Error: ${errMessage}]`);
                    sendChunk('', 'stop');
                    res.write('data: [DONE]\n\n');
                    res.end();
                } else {
                    res.status(500).json({ error: { message: errMessage, type: 'internal_error' } });
                }
                return;
            }
        }

        logEntry.inputTokens = finalUsage.input_tokens;
        logEntry.cacheWriteTokens = finalUsage.cache_creation_tokens;
        logEntry.cacheReadTokens = finalUsage.cache_read_tokens;
        logEntry.outputTokens = finalUsage.output_tokens;
        logEntry.costUsd = finalUsage.cost_usd;

        const totalInput = (finalUsage.input_tokens || 0) + (finalUsage.cache_creation_tokens || 0) + (finalUsage.cache_read_tokens || 0);
        const usagePayload = {
            prompt_tokens:     totalInput,
            completion_tokens: finalUsage.output_tokens,
            total_tokens:      totalInput + finalUsage.output_tokens,
            prompt_tokens_details: {
                cached_tokens: finalUsage.cache_read_tokens,
                cache_creation_tokens: finalUsage.cache_creation_tokens,
            },
        };

        // Parse <tool_call> blocks from Claude's response. Exact XML is preferred;
        // one unambiguous malformed block can be repaired, but only for declared tools.
        const toolCallResult = parseToolCallsDetailed(finalText || '', { allowedToolNames });
        const toolCalls = toolCallResult.calls;
        if (toolCallResult.repaired) {
            console.warn(`[${requestId}] WARNING malformed_tool_call_repaired close=${toolCallResult.closeTag || 'unknown'} tool=${toolCalls[0]?.name || 'unknown'}`);
        } else if (toolCallResult.hadToolCallMarkup && toolCalls.length === 0) {
            console.warn(`[${requestId}] WARNING malformed_tool_call_unrecoverable reason=${toolCallResult.malformedReason || 'unknown'} preview=${redactSensitivePreview(finalText || '')}`);
        }
        if (toolCallResult.recoveredJson) {
            console.warn(`[${requestId}] WARNING malformed_tool_call_json_recovered`);
        }

        const rawMarkupPresent = hasInternalBridgeMarkup(finalText || '');

        if (toolCalls.length > 0) {
            // Claude requested tools → return as OpenAI tool_calls for OC to execute
            const textBeforeTools = cleanResponseText(finalText || '');
            const toolNames = toolCalls.map(tc => tc.name).join(', ');
            console.log(`[${requestId}] → tool_calls: [${toolNames}]`);
            pushActivity(requestId, `→ tool_calls: [${toolNames}]`);
            logEntry.activity.push(`→ tool_calls: [${toolNames}]`);

            // Track tool_call_ids for session reuse
            for (const tc of toolCalls) {
                sessionMap.set(tc.id, { sessionId, createdAt: Date.now() });
            }
            console.log(`[${requestId}] sessionMap: stored ${toolCalls.length} tool_call_ids for session=${sessionId.slice(0, 8)} (total=${sessionMap.size})`);

            if (isStream) {
                // Suppress any partial assistant prose before tool calls.
                // Tool-use turns should only surface the tool_calls payload until
                // the loop completes and a final verified reply is ready.
                const tcDelta = {
                    id: completionId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: {
                        tool_calls: toolCalls.map((tc, i) => ({
                            index: i,
                            id: tc.id,
                            type: 'function',
                            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                        })),
                    }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(tcDelta)}\n\n`);

                // Send finish with tool_calls reason (no usage here per OpenAI spec)
                const stopChunk = {
                    id: completionId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                };
                res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
                // Separate usage chunk with empty choices (OpenAI streaming spec)
                const usageChunk = {
                    id: completionId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [],
                    usage: usagePayload,
                };
                res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                res.json({
                    id: completionId, object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: toolCalls.map((tc, i) => ({
                            id: tc.id, index: i, type: 'function',
                            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                        })),
                    }, finish_reason: 'tool_calls' }],
                    usage: usagePayload,
                });
            }
        } else {
            // No tool calls — return clean text with finish_reason: stop.
            // Fail closed if raw bridge markup somehow survives parsing.
            let cleanText = cleanResponseText(finalText);
            if (rawMarkupPresent) {
                console.warn(`[${requestId}] WARNING suppressed_internal_bridge_markup preview=${redactSensitivePreview(finalText || '')}`);
                cleanText = '';
            }
            if (cleanText) sendChunk(cleanText);

            if (isStream) {
                // Stop chunk (no usage here per OpenAI spec)
                const stopChunk = {
                    id: completionId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                };
                res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
                // Separate usage chunk with empty choices (OpenAI streaming spec)
                const usageChunk = {
                    id: completionId, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [],
                    usage: usagePayload,
                };
                res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                res.json({
                    id: completionId, object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, message: { role: 'assistant', content: cleanText || '' }, finish_reason: 'stop' }],
                    usage: usagePayload,
                });
            }
        }

        // Store channel → CLI session mapping (primary session tracking)
        if (routingKey) {
            const prevEntry = channelMap.get(routingKey);
            channelMap.set(routingKey, {
                sessionId,
                createdAt: Date.now(),
                lastCompactionHash: logEntry.pendingCompactionHash ?? prevEntry?.lastCompactionHash ?? null,
            });
            if (logEntry.pendingCompactionHash) delete logEntry.pendingCompactionHash;
            console.log(`[${requestId}] channelMap stored: "${routingKey}" → session=${sessionId.slice(0, 8)} (map size=${channelMap.size})`);
        }

        // If this was a new OC session without convLabel (request 1 of /new),
        // store the greeting response so request 2 can link it to the channel.
        // Store response content for future resume detection (fallback for DMs)
        const cleanedForMap = cleanResponseText(finalText);
        const rKey = contentKey(cleanedForMap);
        if (rKey) {
            responseMap.set(rKey, { sessionId, createdAt: Date.now() });
        }

        logEntry.status = 'ok';
        const elapsed = Date.now() - startTime;
        logEntry.durationMs = elapsed;
        console.log(`[${requestId}] done ${elapsed}ms chunks=${chunksSent}`);
        pushActivity(requestId, `✓ done ${(elapsed / 1000).toFixed(1)}s`);

    } catch (err) {
        stats.errors++;
        logEntry.status = 'error';
        logEntry.error = err.message;
        console.error(`[${requestId}] Unhandled:`, err);
        if (!res.headersSent) res.status(500).json({ error: { message: err.message, type: 'internal_error' } });
        else res.end();
    } finally {
        stats.activeRequests = Math.max(0, stats.activeRequests - 1);
        if (acquiredChannel) {
            const cnt = channelActive.get(acquiredChannel) || 0;
            if (cnt <= 1) channelActive.delete(acquiredChannel);
            else channelActive.set(acquiredChannel, cnt - 1);
        }
        logEntry.durationMs = logEntry.durationMs ?? (Date.now() - startTime);
        saveState();
    }
});

// ─── Status app (port 3458, all interfaces) ───────────────────────────────────
const statusApp = express();

statusApp.use(express.json());

// Dashboard password protection (Basic Auth)
const DASHBOARD_PASS = process.env.DASHBOARD_PASS;
if (DASHBOARD_PASS) {
    const expected = 'Basic ' + Buffer.from('admin:' + DASHBOARD_PASS).toString('base64');
    statusApp.use((req, res, next) => {
        if (req.headers.authorization === expected) return next();
        res.setHeader('WWW-Authenticate', 'Basic realm="Dashboard"');
        res.status(401).send('Unauthorized');
    });
}

// Serve React dashboard (built files)
statusApp.use(express.static(path.join(__dirname, '../dashboard/dist')));

statusApp.get('/status', (req, res) => {
    res.json({
        status: 'running',
        uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
        startedAt: stats.startedAt,
        totalRequests: stats.totalRequests,
        activeRequests: stats.activeRequests,
        lastRequestAt: stats.lastRequestAt,
        lastModel: stats.lastModel,
        errors: stats.errors,
        sessions: getSessionInfo(),
        channels: Array.from(channelMap.entries()).map(([label, val]) => ({
            label: label.replace(/^Guild\s+/, '').slice(0, 40),
            sessionId: val.sessionId.slice(0, 8),
            age: Math.floor((Date.now() - val.createdAt) / 1000),
        })),
        contextWindows: {
            'claude-opus-4-7': getContextWindow('claude-opus-4-7'),
            'claude-opus-4-6': getContextWindow('claude-opus-4-6'),
            'claude-sonnet-4-6': getContextWindow('claude-sonnet-4-6'),
            'claude-haiku-4-5': getContextWindow('claude-haiku-4-5'),
        },
        activity: globalActivity.slice(-30),
        log: [...requestLog].reverse(),
    });
});

statusApp.post('/cleanup', (req, res) => {
    const result = cleanupSessions(); // default: delete sessions older than 24h
    console.log(`[openclaw-claude-bridge] Manual cleanup: deleted ${result.deleted}, remaining ${result.remaining}`);
    res.json(result);
});

// SPA fallback — serve index.html for any non-API route. Express 5 uses
// path-to-regexp v8, where bare '*' is invalid; use middleware as the
// catch-all instead.
statusApp.use((req, res) => {
    res.sendFile(path.join(__dirname, '../dashboard/dist/index.html'));
});

module.exports = { app, statusApp, stats, saveState };
