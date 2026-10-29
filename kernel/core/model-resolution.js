import { routeModel } from '../utils/model-router.js';
import { InternalAPIError } from './errors.js';

export function resolveInternalModel(internalRequest) {
  let resolved;
  try {
    resolved = routeModel(internalRequest.model?.requested);
  } catch (err) {
    throw new InternalAPIError(err.message || 'Unknown model', {
      status: 400,
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'model',
      cause: err,
    });
  }
  return {
    ...internalRequest,
    model: {
      ...(internalRequest.model || {}),
      requested: internalRequest.model?.requested,
      normalized: resolved.model,
      channel: resolved.channel,
      config: resolved.config || null,
    },
  };
}
