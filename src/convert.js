'use strict';

const { classifyParts, AttachmentBudgetError } = require('./attachments');

// Sentinel markers that delimit regions of promptText which must NOT be scrubbed.
// Tool-call JSON arguments and tool-result payloads contain literal data (file
// paths, command output, identifiers) that the orchestrator owns — scrubbing
// them corrupts on-disk reality. We wrap those regions on the way out and strip
// the markers in claude.js after a scope-aware scrub pass.
// Markers are constructed from char codes so they themselves can never be
// substituted by the scrubber.
const NOSCRUB_OPEN  = String.fromCharCode(0x1E) + 'NOSCRUB' + String.fromCharCode(0x1F);
const NOSCRUB_CLOSE = String.fromCharCode(0x1F) + 'NOSCRUB' + String.fromCharCode(0x1E);
function noscrub(text) {
    return NOSCRUB_OPEN + text + NOSCRUB_CLOSE;
}


/**
 * Convert an OpenAI messages array into the bridge's internal shape.
 *
 * Returns:
 *   {
 *     systemPrompt: string,
 *     promptText: string,        // text-mode stdin
 *     attachmentBlocks: array,   // Anthropic content blocks for the FINAL user
 *                                // turn (image, document); empty if no
 *                                // attachments present in the latest user turn
 *   }
 *
 * The bridge sends `promptText` via plain stdin when attachmentBlocks is empty.
 * Otherwise it builds a stream-json input where the final user message has the
 * attachment blocks appended, and the prior conversation is rendered as text
 * via the standard <previous_response>/<tool_result> wrapping.
 *
 * Attachment behavior is controlled by OPENCLAW_BRIDGE_ATTACHMENT_MODE
 * (passthrough = default, describe = drop non-text parts).
 *
 * Handles the full OpenAI message format including tool_calls and tool results
 * so Claude can see the complete conversation history.
 */
function convertMessages(messages, opts = {}) {
    const { turnId = `t-${Date.now().toString(36)}` } = opts;

    const systemParts = [];
    const conversationParts = [];
    let lastUserAttachments = [];

    // Locate the index of the last user message so we know where to attach
    // multimodal blocks. Attachments on earlier user turns get inlined as
    // text-mode descriptions (we don't try to interleave images across turns
    // because the CLI's session resume needs a single coherent transcript).
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const role = msg.role;
        const isLastUser = (i === lastUserIdx);

        if (role === 'developer' || role === 'system') {
            systemParts.push(_classifyToText(msg.content, turnId));
        } else if (role === 'user') {
            const { text, attachments } = _classify(msg.content, turnId);
            if (isLastUser && attachments.length > 0) {
                lastUserAttachments = attachments;
            }
            conversationParts.push(`User: ${text}`);
        } else if (role === 'assistant') {
            // Include both text content and any tool_calls from history
            const text = _classifyToText(msg.content, turnId);
            const parts = [];
            if (text) parts.push(text);

            // Include tool_calls so Claude knows what was previously requested
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const fn = tc.function || {};
                    parts.push(noscrub(`<tool_call>\n{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}\n</tool_call>`));
                }
            }

            if (parts.length > 0) {
                conversationParts.push(`<previous_response>\n${parts.join('\n')}\n</previous_response>`);
            }
        } else if (role === 'tool') {
            // Tool results from OC's execution — include so Claude can use them
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            const text = _classifyToText(msg.content, turnId);
            if (text) {
                conversationParts.push(noscrub(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`));
            }
        }
    }

    return {
        systemPrompt: systemParts.join('\n\n'),
        promptText: conversationParts.join('\n\n'),
        attachmentBlocks: lastUserAttachments,
    };
}

function _classify(content, turnId) {
    try {
        return classifyParts(content, turnId);
    } catch (err) {
        if (err instanceof AttachmentBudgetError) {
            console.warn(`[convert.js] ${err.message}`);
            return { text: '[attachments dropped: budget]', attachments: [] };
        }
        console.warn(`[convert.js] classify failed: ${err.message}`);
        return { text: String(content || ''), attachments: [] };
    }
}

function _classifyToText(content, turnId) {
    const { text } = _classify(content, turnId);
    return text;
}

/**
 * Extract plain text from a content field (string or array of parts).
 * Kept for backward compatibility with any direct callers.
 */
function extractContent(content) {
    if (typeof content === 'string') return content;
    if (content === null || content === undefined) return '';
    if (Array.isArray(content)) {
        return content
            .filter(p => p.type === 'text')
            .map(p => p.text)
            .join('\n');
    }
    return String(content ?? '');
}

/**
 * Extract only the new messages after the last assistant tool_calls message.
 * Used for --resume mode (tool loop) to avoid re-sending the full history.
 *
 * Returns {newText, attachmentBlocks} or null if no tool_calls found.
 */
function extractNewMessages(messages, opts = {}) {
    const { toolResultCap = 15000, turnId = `t-${Date.now().toString(36)}` } = opts;

    // Find the last assistant message with tool_calls (from the tail)
    let lastToolCallIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && Array.isArray(messages[i].tool_calls) && messages[i].tool_calls.length > 0) {
            lastToolCallIdx = i;
            break;
        }
    }
    if (lastToolCallIdx === -1) return null;

    // If there's a text-only assistant AFTER the last tool_call assistant,
    // the tool loop is over. Return null to fall through to extractNewUserMessages().
    for (let i = lastToolCallIdx + 1; i < messages.length; i++) {
        if (messages[i].role === 'assistant') {
            return null;
        }
    }

    // Only take messages after the last assistant tool_calls
    const newMessages = messages.slice(lastToolCallIdx + 1);
    let lastUserIdx = -1;
    for (let i = newMessages.length - 1; i >= 0; i--) {
        if (newMessages[i].role === 'user') { lastUserIdx = i; break; }
    }

    const parts = [];
    let attachmentBlocks = [];

    for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        if (msg.role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            let { text } = _classify(msg.content, turnId);
            if (text) {
                if (text.length > toolResultCap) text = text.slice(0, toolResultCap) + '\n[... truncated]';
                parts.push(noscrub(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`));
            }
        } else if (msg.role === 'user') {
            const { text, attachments } = _classify(msg.content, turnId);
            if (i === lastUserIdx && attachments.length > 0) attachmentBlocks = attachments;
            parts.push(`User: ${text}`);
        }
    }
    return { newText: parts.join('\n\n'), attachmentBlocks };
}

/**
 * Extract messages after the last assistant message (regardless of tool_calls).
 * Used for --resume mode when the conversation has no tool_calls (simple continuation).
 *
 * Returns {newText, attachmentBlocks} or null if nothing new found.
 */
function extractNewUserMessages(messages, opts = {}) {
    const { toolResultCap = 15000, turnId = `t-${Date.now().toString(36)}` } = opts;

    // Find the last assistant message (from the tail)
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
            lastAssistantIdx = i;
            break;
        }
    }
    if (lastAssistantIdx === -1) return null;

    // Only take messages after the last assistant message
    const newMessages = messages.slice(lastAssistantIdx + 1);
    if (newMessages.length === 0) return null;

    let lastUserIdx = -1;
    for (let i = newMessages.length - 1; i >= 0; i--) {
        if (newMessages[i].role === 'user') { lastUserIdx = i; break; }
    }

    const parts = [];
    let attachmentBlocks = [];

    for (let i = 0; i < newMessages.length; i++) {
        const msg = newMessages[i];
        if (msg.role === 'user') {
            const { text, attachments } = _classify(msg.content, turnId);
            if (i === lastUserIdx && attachments.length > 0) attachmentBlocks = attachments;
            if (text) parts.push(text);
        } else if (msg.role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            let { text } = _classify(msg.content, turnId);
            if (text) {
                if (text.length > toolResultCap) text = text.slice(0, toolResultCap) + '\n[... truncated]';
                parts.push(noscrub(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`));
            }
        }
    }
    return parts.length > 0 ? { newText: parts.join('\n\n'), attachmentBlocks } : null;
}

/**
 * Compact version of convertMessages for context refresh.
 * Truncates assistant text and tool results to reduce prompt size.
 * Same return shape as convertMessages.
 */
function convertMessagesCompact(messages, opts = {}) {
    const {
        assistantCap = 1500,
        recentToolCap = 2000,
        oldToolCap = 500,
        recentTurns = 10,
        turnId = `t-${Date.now().toString(36)}`,
    } = opts;

    const systemParts = [];
    const conversationParts = [];
    let lastUserAttachments = [];

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { lastUserIdx = i; break; }
    }

    // Count user turns to determine recent vs old
    let userTurnCount = 0;
    for (const msg of messages) {
        if (msg.role === 'user') userTurnCount++;
    }
    const recentCutoff = Math.max(0, userTurnCount - recentTurns);

    let currentUserTurn = 0;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const role = msg.role;

        if (role === 'developer' || role === 'system') {
            systemParts.push(_classifyToText(msg.content, turnId));
        } else if (role === 'user') {
            currentUserTurn++;
            const { text, attachments } = _classify(msg.content, turnId);
            if (i === lastUserIdx && attachments.length > 0) lastUserAttachments = attachments;
            conversationParts.push(`User: ${text}`);
        } else if (role === 'assistant') {
            const text = _classifyToText(msg.content, turnId);
            const parts = [];
            if (text) {
                if (text.length > assistantCap) {
                    parts.push(text.slice(0, assistantCap) + '\n[... truncated]');
                } else {
                    parts.push(text);
                }
            }
            if (Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const fn = tc.function || {};
                    parts.push(noscrub(`<tool_call>\n{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}\n</tool_call>`));
                }
            }
            if (parts.length > 0) {
                conversationParts.push(`<previous_response>\n${parts.join('\n')}\n</previous_response>`);
            }
        } else if (role === 'tool') {
            const toolName = msg.name || '';
            const toolId = msg.tool_call_id || '';
            const { text } = _classify(msg.content, turnId);
            if (text) {
                const cap = currentUserTurn >= recentCutoff ? recentToolCap : oldToolCap;
                const truncated = text.length > cap ? text.slice(0, cap) + '\n[... truncated]' : text;
                conversationParts.push(noscrub(`<tool_result name="${toolName}" tool_call_id="${toolId}">\n${truncated}\n</tool_result>`));
            }
        }
    }

    return {
        systemPrompt: systemParts.join('\n\n'),
        promptText: conversationParts.join('\n\n'),
        attachmentBlocks: lastUserAttachments,
    };
}

module.exports = { convertMessages, convertMessagesCompact, extractNewMessages, extractNewUserMessages, extractContent, NOSCRUB_OPEN, NOSCRUB_CLOSE };
