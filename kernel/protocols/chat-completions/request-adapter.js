import { InternalAPIError } from '../../core/errors.js';
import { createInternalRequest, normalizeInternalTools } from '../../core/internal-request.js';
import { getRawJsonPromptForRequest } from '../../utils/response-utils.js';

function normalizeResponseFormat(body) {
  const format = body.response_format;
  if (!format) return { type: 'text', jsonSchema: null };
  if (format.type === 'json_object') return { type: 'json_object', jsonSchema: null };
  if (format.type === 'json_schema') return { type: 'json_schema', jsonSchema: format.json_schema || format.schema || null };
  return { type: 'text', jsonSchema: null };
}

export function createChatCompletionsRequestAdapter(req) {
  const body = req?.body || {};
  if (!body.model || typeof body.model !== 'string') {
    throw new InternalAPIError('model is required', { status: 400, type: 'invalid_request_error', param: 'model', code: 'missing_required_parameter' });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new InternalAPIError('messages array is required and must not be empty', { status: 400, type: 'invalid_request_error', param: 'messages', code: 'missing_required_parameter' });
  }

  return createInternalRequest({
    protocol: 'chat_completions',
    model: body.model,
    stream: body.stream !== false,
    messages: body.messages,
    tools: normalizeInternalTools(body.tools),
    toolChoice: body.tool_choice ?? 'auto',
    generation: {
      maxTokens: body.max_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      reasoning: {
        enabled: body.thinking_enabled ?? true,
        effort: body.reasoning_effort,
      },
    },
    responseFormat: normalizeResponseFormat(body),
    raw: {
      body,
      rawJsonText: getRawJsonPromptForRequest(req),
    },
    metadata: {
      path: req?.originalUrl || req?.path || '/v1/chat/completions',
      headers: req?.headers || {},
      promptInjectionEnabled: req?.omni?.promptInjectionEnabled,
    },
  });
}
