import { InternalAPIError, toInternalAPIError } from './errors.js';
import { createRunFailed } from './internal-events.js';
import { resolveInternalModel } from './model-resolution.js';
import { runDeepSeek } from '../channels/deepseek/runner.js';

const RUNNERS = {
  deepseek: runDeepSeek,
};

export function getChannelRunner(channel) {
  return RUNNERS[channel] || null;
}

export function isChannelRunnerAvailable(channel) {
  return !!getChannelRunner(channel);
}

export function prepareInternalGeneration(internalRequest) {
  const resolvedRequest = resolveInternalModel(internalRequest);
  const runner = getChannelRunner(resolvedRequest.model.channel);
  if (!runner) {
    throw new InternalAPIError(`The selected model is not yet available through the Internal Event layer: ${resolvedRequest.model.requested}`, {
      status: 400,
      type: 'invalid_request_error',
      code: 'unsupported_model_for_internal_events',
      param: 'model',
    });
  }
  return { resolvedRequest, runner };
}

export async function* generateInternalEvents(internalRequest, context = {}) {
  let resolvedRequest;
  try {
    resolvedRequest = resolveInternalModel(internalRequest);
    const runner = getChannelRunner(resolvedRequest.model.channel);
    if (!runner) {
      throw new InternalAPIError(`The selected model is not yet available through the Internal Event layer: ${resolvedRequest.model.requested}`, {
        status: 400,
        type: 'invalid_request_error',
        code: 'unsupported_model_for_internal_events',
        param: 'model',
      });
    }
    yield* runner(resolvedRequest, context);
  } catch (err) {
    const apiError = toInternalAPIError(err, { status: 500, type: 'api_error' });
    if (!resolvedRequest) throw apiError;
    yield createRunFailed({
      requestId: resolvedRequest.id,
      responseId: context.responseId,
      error: apiError,
    });
  }
}
