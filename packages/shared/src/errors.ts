import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'permission_denied',
  'not_found',
  'session_not_found',
  'session_limit_reached',
  'rate_limited',
  'cancelled',
  'provider_not_configured',
  'provider_timeout',
  'provider_error',
  'admin_not_configured',
  'internal_error',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  permission_denied: 403,
  not_found: 404,
  session_not_found: 404,
  session_limit_reached: 503,
  rate_limited: 429,
  cancelled: 499,
  provider_not_configured: 503,
  provider_timeout: 504,
  provider_error: 502,
  admin_not_configured: 503,
  internal_error: 500,
};

export interface GatewayErrorOptions {
  details?: unknown;
  cause?: unknown;
  retryAfterSeconds?: number;
}

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'GatewayError';
    this.code = code;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export const ErrorBodySchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string().optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
    details: z.unknown().optional(),
  }),
});

export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** Details are only exposed for invalid_request, where they describe the caller's own input. */
export function toErrorBody(error: GatewayError, requestId?: string): ErrorBody {
  const body: ErrorBody['error'] = { code: error.code, message: error.message };
  if (requestId !== undefined) body.requestId = requestId;
  if (error.retryAfterSeconds !== undefined) body.retryAfterSeconds = error.retryAfterSeconds;
  if (error.code === 'invalid_request' && error.details !== undefined) {
    body.details = error.details;
  }
  return { error: body };
}

export function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  return new GatewayError('internal_error', 'Internal error', { cause: error });
}
