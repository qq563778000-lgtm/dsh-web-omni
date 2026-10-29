export class InternalAPIError extends Error {
  constructor(message, {
    status = 500,
    type = 'api_error',
    code = null,
    param = null,
    retryable = false,
    cause = undefined,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'InternalAPIError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
    this.retryable = retryable;
  }
}

export function isInternalAPIError(err) {
  return err instanceof InternalAPIError;
}

export function toInternalAPIError(err, defaults = {}) {
  if (isInternalAPIError(err)) return err;
  return new InternalAPIError(err?.message || defaults.message || 'Internal Server Error', {
    status: defaults.status || err?.status || 500,
    type: defaults.type || err?.type || 'api_error',
    code: defaults.code || err?.code || null,
    param: defaults.param || err?.param || null,
    retryable: defaults.retryable || err?.retryable || false,
    cause: err,
  });
}

export function errorToResponseError(err) {
  const apiError = toInternalAPIError(err);
  const error = {
    message: apiError.message,
    type: apiError.type,
  };
  if (apiError.param !== null && apiError.param !== undefined) error.param = apiError.param;
  if (apiError.code !== null && apiError.code !== undefined) error.code = apiError.code;
  return {
    status: apiError.status || 500,
    error,
  };
}
