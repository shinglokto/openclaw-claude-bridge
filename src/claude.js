'use strict';

const { spawn } = require('child_process');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// --- Stable alias per CLI session ---
// Each session keeps one alias so resumed requests don't accumulate different
// names in the Claude context (which would leak un-replaced aliases in output).
const PREFIXES = ['Chat', 'Dev', 'Run', 'Ask', 'Net', 'App', 'Zen', 'Arc', 'Dot', 'Amp', 'Hex', 'Orb', 'Elm', 'Oak', 'Sky'];
const SUFFIXES = ['Kit', 'Box', 'Pod', 'Hub', 'Lab', 'Ops', 'Bay', 'Tap', 'Rim', 'Fog', 'Dew', 'Fin', 'Gem', 'Jet', 'Cog'];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sessionAliasMap = new Map(); // sessionId → { alias, aliasLower, lastUsed }

function getSessionAlias(sessionId) {
    if (!sessionId) {
        const alias = pick(PREFIXES) + pick(SUFFIXES);
        return { alias, aliasLower: alias.toLowerCase() };
    }
    let entry = sessionAliasMap.get(sessionId);
    if (entry) {
        entry.lastUsed = Date.now();
        return entry;
    }
    const alias = pick(PREFIXES) + pick(SUFFIXES);
    entry = { alias, aliasLower: alias.toLowerCase(), lastUsed: Date.now() };
    sessionAliasMap.set(sessionId, entry);
    return entry;
}

function clearSessionAlias(sessionId) {
    sessionAliasMap.delete(sessionId);
}

// Evict stale entries every 10 min (unused >1h)
setInterval(() => {
    const cutoff = Date.now() - 3600_000;
    for (const [id, e] of sessionAliasMap) {
        if (e.lastUsed < cutoff) sessionAliasMap.delete(id);
    }
}, 600_000).unref();

/**
 * Map OpenClaw model IDs to Claude CLI model names.
 * Uses CLI aliases (opus/sonnet/haiku) by default so we always get the latest
 * model without code changes.  Override via env vars in .env if needed,
 * e.g. OPUS_MODEL=opus[1m] when 1M context becomes available.
 */
function resolveModel(modelId) {
    const modelMap = {
        'claude-opus-latest':    process.env.OPUS_MODEL   || 'opus',
        'claude-sonnet-latest':  process.env.SONNET_MODEL || 'sonnet',
        'claude-haiku-latest':   process.env.HAIKU_MODEL  || 'haiku',
    };
    return modelMap[modelId] || modelId;
}

/** Context window size per model, derived from the resolved CLI model name. */
function getContextWindow(modelId) {
    const resolved = resolveModel(modelId);
    return resolved.includes('[1m]') ? 1_000_000 : 200_000;
}

/**
 * Run Claude CLI with the given system prompt and conversation text.
 *
 * @param {string} systemPrompt  Combined developer message + tool instructions
 * @param {string} promptText    Conversation history + user message
 * @param {string} modelId       OpenClaw model ID
 * @param {function} onChunk     Called with each text chunk as it arrives
 * @returns {Promise<string>}    Resolves with the final complete text
 */
/**
 * @typedef {{ text: string, usage: { input_tokens: number, output_tokens: number } }} ClaudeResult
 */

const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS) || 120000; // 2 min idle = dead

/**
 * Map OC reasoning_effort levels to Claude CLI --effort levels.
 * OC sends: "minimal" | "low" | "medium" | "high" | "xhigh"
 * Claude CLI accepts: "low" | "medium" | "high"
 */
function mapEffort(reasoningEffort) {
    if (!reasoningEffort) return null;
    const map = {
        'minimal': 'low',
        'low':     'medium',
        'medium':  'high',
        'high':    'max',
        'xhigh':   'max',
    };
    return map[reasoningEffort] || null;
}

function runClaude(systemPrompt, promptText, modelId, onChunk, signal, reasoningEffort, sessionId, isResume) {
    // Stable alias per session — see getSessionAlias() above.
    const { alias, aliasLower } = getSessionAlias(sessionId);
    if (systemPrompt) {
        systemPrompt = systemPrompt
            .replace(/OpenClaw/g, alias)
            .replace(/openclaw/g, aliasLower);
    }
    promptText = promptText
        .replace(/OpenClaw/g, alias)
        .replace(/openclaw/g, aliasLower);

    return new Promise((resolve, reject) => {
        const model = resolveModel(modelId);

        const args = [
            '--print',
            '--dangerously-skip-permissions',
            '--output-format', 'stream-json',
            '--verbose',
        ];

        // Always pass --model (not persisted in session)
        args.push('--model', model);

        if (isResume && sessionId) {
            // Resume existing session — conversation history already in session
            args.push('--resume', sessionId);
        } else if (sessionId) {
            // New session
            args.push('--session-id', sessionId);
        }

        // Replace Claude Code default system prompt (removes ~15-20KB of irrelevant noise)
        if (systemPrompt) {
            args.push('--system-prompt', systemPrompt);
        }

        // Always disable native tools (CLI flag, not session property)
        args.push('--tools', '');

        // Map OC reasoning_effort → Claude CLI --effort
        const effort = mapEffort(reasoningEffort);
        if (effort) {
            args.push('--effort', effort);
        }

        const env = { ...process.env };

        // Disable thinking when OC says reasoning=false (no reasoning_effort)
        if (!reasoningEffort) {
            env.MAX_THINKING_TOKENS = '0';
        }

        const thinking = reasoningEffort ? 'on' : 'off';
        console.log(`[claude.js] Spawning: ${CLAUDE_BIN} ${args.slice(0, 6).join(' ')} ... model=${model} effort=${effort || 'default'} thinking=${thinking} resume=${!!isResume}`);

        const proc = spawn(CLAUDE_BIN, args, {
            cwd: '/tmp',
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let settled = false;
        const kill = (reason) => {
            if (settled) return;
            settled = true;
            proc.kill('SIGTERM');
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
            reject(new Error(reason));
        };

        // Kill on client disconnect (AbortSignal)
        if (signal) {
            signal.addEventListener('abort', () => kill('Client disconnected'), { once: true });
        }

        // Idle timeout: reset on every stdout activity.
        // Claude is alive as long as it produces output (tool calls, results, etc.)
        // Only kill if it goes silent for IDLE_TIMEOUT_MS.
        let idleTimer = setTimeout(() => kill(`Idle timeout (${IDLE_TIMEOUT_MS / 1000}s no activity)`), IDLE_TIMEOUT_MS);
        const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => kill(`Idle timeout (${IDLE_TIMEOUT_MS / 1000}s no activity)`), IDLE_TIMEOUT_MS);
        };

        // Hard timeout: absolute max runtime regardless of activity (20 min)
        const MAX_RUN_MS = 20 * 60 * 1000;
        const hardTimer = setTimeout(() => kill(`Hard timeout (${MAX_RUN_MS / 60000}min)`), MAX_RUN_MS);

        // Write conversation to stdin
        proc.stdin.write(promptText);
        proc.stdin.end();

        let fullText = '';
        let fullUsage = { input_tokens: 0, output_tokens: 0 };
        let buffer = '';

        proc.stdout.on('data', (chunk) => {
            resetIdle(); // Claude is alive — reset idle timer
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                try {
                    const event = JSON.parse(trimmed);
                    handleEvent(event, onChunk, (text) => { fullText = text; }, (u) => { fullUsage = u; });
                } catch {
                    // Non-JSON line (e.g. debug output), ignore
                }
            }
        });

        proc.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) console.error(`[claude stderr] ${msg}`);
        });

        proc.on('close', (code) => {
            clearTimeout(idleTimer);
            clearTimeout(hardTimer);
            if (settled) return;
            settled = true;

            // Process any remaining buffered data
            if (buffer.trim()) {
                try {
                    const event = JSON.parse(buffer.trim());
                    handleEvent(event, onChunk, (text) => { fullText = text; }, (u) => { fullUsage = u; });
                } catch {}
            }

            if (code !== 0 && !fullText) {
                reject(new Error(`Claude exited with code ${code}`));
            } else {
                // Inbound: restore alias → openclaw
                if (fullText) {
                    fullText = fullText
                        .replace(new RegExp(alias, 'g'), 'OpenClaw')
                        .replace(new RegExp(aliasLower, 'g'), 'openclaw');
                }
                resolve({ text: fullText, usage: fullUsage });
            }
        });

        proc.on('error', (err) => {
            clearTimeout(idleTimer);
            clearTimeout(hardTimer);
            if (settled) return;
            settled = true;
            reject(new Error(`Failed to spawn Claude: ${err.message}`));
        });
    });
}

/**
 * Parse a stream-json event and extract text content.
 *
 * With --tools "" (no native tools), Claude only outputs text.
 * We extract the final result text and usage from the stream.
 */
function handleEvent(event, onChunk, setFull, setUsage) {
    if (event.type === 'result') {
        const result = event.result;
        if (typeof result === 'string' && result) {
            setFull(result);
        }
        // Pass through the full token usage breakdown + cost from Claude CLI.
        const u = event.usage;
        if (u && typeof u.input_tokens === 'number') {
            setUsage({
                input_tokens:          u.input_tokens ?? 0,
                cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
                cache_read_tokens:     u.cache_read_input_tokens ?? 0,
                output_tokens:         u.output_tokens ?? 0,
                cost_usd:              event.total_cost_usd ?? 0,
            });
        }
    }
}

module.exports = { runClaude, getContextWindow, clearSessionAlias };
