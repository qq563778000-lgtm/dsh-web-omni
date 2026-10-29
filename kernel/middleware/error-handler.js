/**
 * 统一错误处理中间件
 *
 * 根据请求路径自动选择 OpenAI、Claude 或 Responses 格式的错误响应。
 *
 * OpenAI 格式:
 * {
 *   error: {
 *     message: string,
 *     type: "invalid_request_error" | "api_error" | "authentication_error" | "rate_limit_error",
 *     param: string | null,
 *     code: string | null
 *   }
 * }
 *
 * Claude/Anthropic 格式:
 * {
 *   type: "error",
 *   error: {
 *     type: "invalid_request_error" | "api_error" | ...,
 *     message: string
 *   }
 * }
 */

/**
 * 判断是否为 Claude API 路径
 */
function isClaudePath(req) {
  return req.path?.startsWith('/v1/messages');
}

function isResponsesPath(req) {
  return req.path?.startsWith('/v1/responses');
}

/**
 * OpenAI 格式错误
 */
function openAIError(status, message, type = 'api_error', param = null, code = null) {
  const error = { message, type };
  if (param !== null) error.param = param;
  if (code !== null) error.code = code;
  return { error };
}

/**
 * Claude 格式错误
 */
function claudeError(message, type = 'api_error') {
  return {
    type: 'error',
    error: { type, message },
  };
}

function responsesError(status, message, type = 'api_error', param = null, code = null) {
  return openAIError(status, message, type, param, code);
}

/**
 * 根据错误信息推断 HTTP 状态码和错误类型
 */
function categorizeError(err) {
  const msg = (err.message || '').toLowerCase();

  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) {
    return { status: 429, type: 'rate_limit_error' };
  }
  if (msg.includes('auth') || msg.includes('token') || msg.includes('key') || msg.includes('401')) {
    return { status: 401, type: 'authentication_error' };
  }
  if (msg.includes('not found') || msg.includes('404') || msg.includes('unknown model')) {
    return { status: 404, type: 'invalid_request_error' };
  }
  if (msg.includes('invalid') || msg.includes('required') || msg.includes('400')) {
    return { status: 400, type: 'invalid_request_error' };
  }
  if (msg.includes('banned') || msg.includes('muted') || msg.includes('403')) {
    return { status: 403, type: 'permission_error' };
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('overloaded') || msg.includes('503')) {
    return { status: 503, type: 'overloaded_error' };
  }

  return { status: 500, type: 'api_error' };
}

export function errorHandler(err, req, res, next) {
  // 避免重复处理
  if (res.headersSent) {
    return next(err);
  }

  console.error('Error:', err.message);

  const { status, type } = categorizeError(err);
  const message = err.message || 'Internal Server Error';

  if (isClaudePath(req)) {
    return res.status(status).json(claudeError(message, type));
  }
  if (isResponsesPath(req)) {
    return res.status(status).json(responsesError(status, message, type, err.param || null, err.code || null));
  }

  // 默认使用 OpenAI 格式
  return res.status(status).json(openAIError(status, message, type, err.param || null, err.code || null));
}
