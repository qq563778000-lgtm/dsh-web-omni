import { textFromContent } from '../utils/response-utils.js';

export function createInternalId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeContentParts(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return normalizeContentPart(content);
  return content.flatMap(normalizeContentPart).filter(Boolean);
}

function normalizeContentPart(part) {
  if (part == null) return [];
  if (typeof part === 'string') return [{ type: 'text', text: part }];
  if (typeof part !== 'object') return [{ type: 'text', text: String(part) }];

  if (part.type === 'text') return [{ type: 'text', text: String(part.text ?? '') }];
  if (part.type === 'input_text' || part.type === 'output_text') {
    return [{ type: 'text', text: String(part.text ?? '') }];
  }
  if (part.type === 'image_url') {
    return [{ type: 'image_url', image_url: part.image_url }];
  }
  if (part.type === 'image_source') {
    return [{ type: 'image_source', source: part.source || part.image_source || part }];
  }
  if (part.type === 'input_image') {
    const imageUrl = part.image_url || part.url || part.source?.url;
    return imageUrl ? [{ type: 'image_url', image_url: typeof imageUrl === 'string' ? { url: imageUrl } : imageUrl }] : [{ ...part }];
  }
  if (part.type === 'file' || part.type === 'input_file') return [{ ...part }];
  if (part.type === 'document') return [{ type: 'file', file: part.source || part.file || part }];

  return [{ type: 'text', text: textFromContent(part) }];
}

export function contentPartsToText(content) {
  return textFromContent(normalizeContentParts(content));
}

export function normalizeInternalMessage(message = {}) {
  const role = String(message.role || 'user').toLowerCase();
  return {
    role,
    content: normalizeContentParts(message.content),
    toolCalls: Array.isArray(message.toolCalls) ? message.toolCalls : normalizeOpenAIToolCalls(message.tool_calls),
    toolResult: message.toolResult || null,
    name: message.name || undefined,
    toolCallId: message.toolCallId || message.tool_call_id || undefined,
    metadata: message.metadata || {},
  };
}

export function normalizeOpenAIToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((toolCall, index) => ({
    id: toolCall.id || createInternalId(`call_${index}`),
    type: 'function',
    name: toolCall.function?.name || toolCall.name || '',
    arguments: normalizeToolArguments(toolCall.function?.arguments ?? toolCall.arguments ?? {}),
  })).filter(call => call.name);
}

export function normalizeToolArguments(args) {
  if (args == null) return '{}';
  if (typeof args === 'string') return args || '{}';
  try { return JSON.stringify(args); } catch { return '{}'; }
}

export function normalizeInternalTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(tool => {
    if (!tool || typeof tool !== 'object') return null;
    const fn = tool.function || tool;
    const name = fn.name || tool.name;
    if (!name || typeof name !== 'string') return null;
    return {
      type: 'function',
      name,
      description: fn.description || tool.description || '',
      parameters: Object.prototype.hasOwnProperty.call(fn, 'parameters')
        ? fn.parameters
        : (Object.prototype.hasOwnProperty.call(tool, 'parameters') ? tool.parameters : { type: 'object', properties: {} }),
      metadata: tool.metadata || {},
    };
  }).filter(Boolean);
}

export function internalToolsToOpenAI(tools) {
  return normalizeInternalTools(tools).map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

export function normalizeToolChoice(toolChoice) {
  if (toolChoice == null || toolChoice === 'auto') return { mode: 'auto', name: null, raw: toolChoice ?? 'auto' };
  if (toolChoice === 'none') return { mode: 'none', name: null, raw: toolChoice };
  if (toolChoice === 'required' || toolChoice === 'any') return { mode: 'required', name: null, raw: toolChoice };
  const name = toolChoice?.function?.name || toolChoice?.name;
  if (name) return { mode: 'specific', name, raw: toolChoice };
  return { mode: 'auto', name: null, raw: toolChoice };
}

export function internalToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice || toolChoice.mode === 'auto') return toolChoice?.raw ?? 'auto';
  if (toolChoice.mode === 'none') return 'none';
  if (toolChoice.mode === 'required') return 'required';
  if (toolChoice.mode === 'specific' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return toolChoice.raw ?? 'auto';
}

export function createInternalRequest({
  protocol,
  model,
  stream = true,
  messages = [],
  instructions = {},
  tools = [],
  toolChoice = 'auto',
  generation = {},
  responseFormat = {},
  conversation = {},
  raw = {},
  metadata = {},
} = {}) {
  return {
    id: metadata.requestId || createInternalId('req'),
    protocol,
    model: {
      requested: model,
      normalized: null,
      channel: null,
      config: null,
    },
    stream: stream !== false,
    messages: messages.map(normalizeInternalMessage),
    instructions: {
      system: instructions.system || '',
      developer: instructions.developer || '',
    },
    tools: normalizeInternalTools(tools),
    toolChoice: normalizeToolChoice(toolChoice),
    generation: {
      maxTokens: generation.maxTokens,
      temperature: generation.temperature,
      topP: generation.topP,
      reasoning: {
        enabled: generation.reasoning?.enabled ?? false,
        effort: generation.reasoning?.effort,
      },
    },
    responseFormat: {
      type: responseFormat.type || 'text',
      jsonSchema: responseFormat.jsonSchema || null,
    },
    conversation: {
      id: conversation.id || null,
      previousResponseId: conversation.previousResponseId || null,
      parentMessageId: conversation.parentMessageId || null,
    },
    raw: {
      body: raw.body || {},
      rawJsonText: raw.rawJsonText || '',
    },
    metadata,
  };
}

export function internalMessagesToOpenAI(messages) {
  return (messages || []).map(msg => {
    const out = {
      role: msg.role,
      content: msg.content || [],
    };
    if (msg.name) out.name = msg.name;
    if (msg.toolCallId) out.tool_call_id = msg.toolCallId;
    if (Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
      out.tool_calls = msg.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: normalizeToolArguments(call.arguments) },
      }));
    }
    return out;
  });
}
