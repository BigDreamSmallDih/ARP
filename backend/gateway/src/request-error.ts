import { ZodError } from 'zod';
import { GatewayError, toGatewayError } from '@arp/shared';

function readStatusCode(error: Error): number | undefined {
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : undefined;
}

export function toRequestError(error: Error): GatewayError {
  if (error instanceof GatewayError) return error;

  if (error instanceof ZodError) {
    return new GatewayError('invalid_request', 'Request validation failed', {
      details: error.issues,
    });
  }

  // Fastify raises 4xx errors itself for malformed JSON, oversized bodies and similar.
  const status = readStatusCode(error);
  if (status !== undefined && status >= 400 && status < 500) {
    return new GatewayError(status === 404 ? 'not_found' : 'invalid_request', error.message, {
      cause: error,
    });
  }

  return toGatewayError(error);
}
