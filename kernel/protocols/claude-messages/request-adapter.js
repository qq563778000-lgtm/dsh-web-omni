import { InternalAPIError } from '../../core/errors.js';
import { createInternalRequest, normalizeContentParts, normalizeInternalTools } from '../../core/internal-request.js';
import { getRawJsonPromptForRequest } from '../../utils/response-utils.js';

function normalizeClaudeContent(content) {
  if (!Array.isArray(content)) return normalizeContentParts(content);
  return content.flatMap(part => {
    if (!part || typeof part !== 'object') return normalizeContentParts(part);
    if (part.type === 'text') return [{ type: 'text', text: part.text || '' }];
    if (part.type === 'image') return [{ type: 'image_source', source: part.source }];
    if (part.type === 'document') return [{ type: 'file', file: part.source || part }];
    if (part.type === 'tool_result') return [{ type: 'text', text: typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '') }];
    return normalizeContentParts(part);
  });
}

function normalizeClaudeMessages(messages) {
  const out = [];
  for (const msg of messages || []) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolCalls = [];
      const textParts = [];
      for (const part of msg.content) {
        if (part?.type === 'tool_use') {
          toolCalls.push({ id: part.id, type: 'function', name: part.name, arguments: JSON.stringify(part.input || {}) });
        } else {
          textParts.push(...normalizeClaudeContent([part]));
        }
      }
      out.push({ role: 'assistant', content: textParts, toolCalls });
      continue;
    }

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const normalParts = [];
      for (const part of msg.content) {
        if (part?.type === 'tool_result') {
          out.push({ role: 'tool', content: normalizeClaudeContent([part]), tool_call_id: part.tool_use_id });
        } else {
          normalParts.push(...normalizeClaudeContent([part]));
        }
      }
      if (normalParts.length) out.push({ role: 'user', content: normalParts });
      continue;
    }

    out.push({ role: msg.role || 'user', content: normalizeClaudeContent(msg.content) });
  }
  return out;
}

function normalizeClaudeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return normalizeInternalTools(tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema ?? tool.parameters ?? { type: 'object', properties: {} },
  })));
}

function normalizeClaudeToolChoice(toolChoice) {
  if (!toolChoice) return 'auto';
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) return { name: toolChoice.name };
  return toolChoice;
}

export function createClaudeMessagesRequestAdapter(req) {
  const body = req?.body || {};
  if (!body.model || typeof body.model !== 'string') {
    throw new InternalAPIError('model is required', { status: 400, type: 'invalid_request_error', param: 'model', code: 'missing_required_parameter' });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new InternalAPIError('messages array is required and must not be empty', { status: 400, type: 'invalid_request_error', param: 'messages', code: 'missing_required_parameter' });
  }

  return createInternalRequest({
    protocol: 'claude_messages',
    model: body.model,
    stream: body.stream !== false,
    messages: normalizeClaudeMessages(body.messages),
    instructions: { system: Array.isArray(body.system) ? body.system.map(part => part.text || '').join('\n') : (body.system || '') },
    tools: normalizeClaudeTools(body.tools),
    toolChoice: normalizeClaudeToolChoice(body.tool_choice),
    generation: {
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      reasoning: {
        enabled: !!body.thinking,
        effort: body.thinking?.budget_tokens,
      },
    },
    raw: {
      body,
      rawJsonText: getRawJsonPromptForRequest(req),
    },
    metadata: {
      path: req?.originalUrl || req?.path || '/v1/messages',
      headers: req?.headers || {},
      promptInjectionEnabled: req?.omni?.promptInjectionEnabled,
    },
  });
}
