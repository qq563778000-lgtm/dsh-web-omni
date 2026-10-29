import { InternalAPIError } from '../../core/errors.js';
import {
  createInternalRequest,
  normalizeContentParts,
  normalizeInternalTools,
} from '../../core/internal-request.js';
import { getRawJsonPromptForRequest } from '../../utils/response-utils.js';

function normalizeResponsesMessageItem(item) {
  if (typeof item === 'string') {
    return { role: 'user', content: normalizeContentParts(item) };
  }
  if (!item || typeof item !== 'object') {
    return { role: 'user', content: normalizeContentParts(String(item ?? '')) };
  }

  if (item.type === 'message' || item.role) {
    return {
      role: item.role || 'user',
      content: normalizeResponsesContent(item.content),
    };
  }

  if (item.type === 'input_text') {
    return { role: 'user', content: normalizeContentParts({ type: 'input_text', text: item.text || '' }) };
  }

  if (item.type === 'input_image' || item.type === 'input_file') {
    return { role: 'user', content: normalizeResponsesContent([item]) };
  }

  if (item.type === 'function_call_output') {
    return {
      role: 'tool',
      content: normalizeContentParts(item.output || ''),
      tool_call_id: item.call_id,
      name: item.name,
    };
  }

  return { role: 'user', content: normalizeContentParts(JSON.stringify(item)) };
}

function normalizeResponsesContent(content) {
  if (content == null) return [];
  if (typeof content === 'string') return normalizeContentParts(content);
  if (!Array.isArray(content)) return normalizeContentPart(content);
  return content.flatMap(normalizeContentPart).filter(Boolean);
}

function normalizeContentPart(part) {
  if (part == null) return [];
  if (typeof part === 'string') return normalizeContentParts(part);
  if (typeof part !== 'object') return normalizeContentParts(String(part));

  if (part.type === 'input_text' || part.type === 'output_text') {
    return [{ type: 'text', text: String(part.text ?? '') }];
  }
  if (part.type === 'input_image') {
    const url = part.image_url || part.url || part.source?.url;
    if (url) return [{ type: 'image_url', image_url: typeof url === 'string' ? { url } : url }];
  }
  if (part.type === 'input_file') {
    return [{ type: 'input_file', file: part.file || part.source || part }];
  }
  return normalizeContentParts(part);
}

function normalizeResponsesInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: normalizeContentParts(input) }];
  if (Array.isArray(input)) return input.map(normalizeResponsesMessageItem);
  if (input && typeof input === 'object') return [normalizeResponsesMessageItem(input)];
  return [];
}

function normalizeResponseFormat(body) {
  const format = body.text?.format || body.response_format;
  if (!format) return { type: 'text', jsonSchema: null };
  if (format.type === 'json_object') return { type: 'json_object', jsonSchema: null };
  if (format.type === 'json_schema') return { type: 'json_schema', jsonSchema: format.json_schema || format.schema || null };
  return { type: 'text', jsonSchema: null };
}

export function createResponsesRequestAdapter(req) {
  const body = req?.body || {};
  if (!body.model || typeof body.model !== 'string') {
    throw new InternalAPIError('model is required', { status: 400, type: 'invalid_request_error', param: 'model', code: 'missing_required_parameter' });
  }
  if (body.input == null) {
    throw new InternalAPIError('input is required', { status: 400, type: 'invalid_request_error', param: 'input', code: 'missing_required_parameter' });
  }

  const messages = normalizeResponsesInput(body.input);
  if (!messages.length) {
    throw new InternalAPIError('input must contain at least one message', { status: 400, type: 'invalid_request_error', param: 'input', code: 'invalid_input' });
  }

  return createInternalRequest({
    protocol: 'responses',
    model: body.model,
    stream: body.stream === true,
    messages,
    instructions: { system: body.instructions || '' },
    tools: normalizeInternalTools(body.tools),
    toolChoice: body.tool_choice ?? 'auto',
    generation: {
      maxTokens: body.max_output_tokens,
      temperature: body.temperature,
      topP: body.top_p,
      reasoning: {
        enabled: !!body.reasoning,
        effort: body.reasoning?.effort,
      },
    },
    responseFormat: normalizeResponseFormat(body),
    conversation: {
      previousResponseId: body.previous_response_id || null,
    },
    raw: {
      body,
      rawJsonText: getRawJsonPromptForRequest(req),
    },
    metadata: {
      path: req?.originalUrl || req?.path || '/v1/responses',
      headers: req?.headers || {},
      promptInjectionEnabled: req?.omni?.promptInjectionEnabled,
      unsupportedFields: Object.keys(body).filter(key => [
        'background', 'include', 'metadata', 'parallel_tool_calls', 'store', 'truncation', 'user'
      ].includes(key)),
    },
  });
}
