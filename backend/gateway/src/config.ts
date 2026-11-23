import { z } from 'zod';
import type { ProviderSettings } from '@arp/agents';
import { Secret } from '@arp/security';
import type { ProviderId } from '@arp/shared';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface GatewayConfig {
  readonly environment: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly adminToken: string | undefined;
  /** Gateway bearer tokens keyed by agent id. */
  readonly agentTokens: Readonly<Record<string, string | undefined>>;
  /** Provider keys are held as Secret values, so serialising the config cannot reveal them. */
  readonly providers: Readonly<Record<ProviderId, ProviderSettings>>;
  readonly providerMaxOutputTokens: number;
  readonly trustProxy: boolean;
  readonly bodyLimitBytes: number;
  readonly limits: {
    readonly requestsPerMinute: number;
    readonly authFailures: number;
    readonly providerCallsPerMinute: number;
  };
  readonly supabaseConfigured: boolean;
  readonly dashboardOrigin: string | undefined;
  readonly sessions: {
    readonly max: number;
    readonly maxPerAgent: number;
    readonly idleTtlSeconds: number;
  };
  readonly auditBufferSize: number;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Empty strings in .env files mean "not set". */
function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value;
}

const secret = z.preprocess(
  emptyToUndefined,
  z.string().min(32, 'must be at least 32 characters').optional(),
);

const text = z.preprocess(emptyToUndefined, z.string().optional());

/** Model ids end up in a URL path for Gemini, so only plain identifier characters are allowed. */
const model = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/, 'must be a plain model id such as "name-1.0"')
    .optional(),
);

/** zod's default enum error repeats the rejected value, which could be a secret pasted on the wrong line. */
function oneOf<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, { message: `must be one of: ${values.join(', ')}` });
}

const flag = z.preprocess(
  emptyToUndefined,
  oneOf(['true', 'false']).default('false').transform((value) => value === 'true'),
);

function integer(fallback: number, min: number, max: number) {
  return z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));
}

const envSchema = z
  .object({
    NODE_ENV: z.preprocess(
      emptyToUndefined,
      oneOf(['development', 'test', 'production']).default('development'),
    ),
    HOST: z.preprocess(emptyToUndefined, z.string().default('127.0.0.1')),
    PORT: integer(8787, 1, 65535),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      oneOf(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ),
    GATEWAY_ADMIN_TOKEN: secret,
    GATEWAY_TOKEN_CHATGPT: secret,
    GATEWAY_TOKEN_CLAUDE: secret,
    GATEWAY_TOKEN_GEMINI: secret,
    OPENAI_API_KEY: text,
    OPENAI_MODEL: model,
    ANTHROPIC_API_KEY: text,
    ANTHROPIC_MODEL: model,
    GEMINI_API_KEY: text,
    GEMINI_MODEL: model,
    PROVIDER_TIMEOUT_MS: integer(30_000, 1_000, 120_000),
    PROVIDER_MAX_OUTPUT_TOKENS: integer(1_024, 1, 8_192),
    TRUST_PROXY: flag,
    REQUEST_BODY_LIMIT_BYTES: integer(262_144, 1_024, 10_485_760),
    RATE_LIMIT_PER_MINUTE: integer(120, 1, 100_000),
    AUTH_FAILURE_LIMIT: integer(10, 1, 1_000),
    PROVIDER_CALLS_PER_MINUTE: integer(20, 1, 10_000),
    SUPABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
    SUPABASE_SERVICE_ROLE_KEY: text,
    DASHBOARD_ORIGIN: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .url()
        .transform((value) => new URL(value).origin)
        .optional(),
    ),
    SESSION_IDLE_TTL_SECONDS: integer(1800, 30, 86400),
    MAX_SESSIONS: integer(100, 1, 10000),
    MAX_SESSIONS_PER_AGENT: integer(10, 1, 10000),
    AUDIT_BUFFER_SIZE: integer(500, 1, 100000),
  })
  .superRefine((env, ctx) => {
    if ((env.SUPABASE_URL === undefined) !== (env.SUPABASE_SERVICE_ROLE_KEY === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SUPABASE_URL'],
        message: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set together',
      });
    }

    const tokens: Array<[string, string | undefined]> = [
      ['GATEWAY_ADMIN_TOKEN', env.GATEWAY_ADMIN_TOKEN],
      ['GATEWAY_TOKEN_CHATGPT', env.GATEWAY_TOKEN_CHATGPT],
      ['GATEWAY_TOKEN_CLAUDE', env.GATEWAY_TOKEN_CLAUDE],
      ['GATEWAY_TOKEN_GEMINI', env.GATEWAY_TOKEN_GEMINI],
    ];
    const firstOwner = new Map<string, string>();
    for (const [name, value] of tokens) {
      if (value === undefined) continue;
      const owner = firstOwner.get(value);
      if (owner === undefined) {
        firstOwner.set(value, name);
      } else {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `must differ from ${owner}`,
        });
      }
    }
  });

function providerSettings(
  apiKey: string | undefined,
  modelId: string | undefined,
  timeoutMs: number,
): ProviderSettings {
  return { apiKey: apiKey === undefined ? undefined : new Secret(apiKey), model: modelId, timeoutMs };
}

/** Issue messages never contain secret values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const name = issue.path.join('.');
        return name === '' ? issue.message : `${name}: ${issue.message}`;
      }),
    );
  }

  const values = parsed.data;
  return {
    environment: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    adminToken: values.GATEWAY_ADMIN_TOKEN,
    agentTokens: {
      chatgpt: values.GATEWAY_TOKEN_CHATGPT,
      claude: values.GATEWAY_TOKEN_CLAUDE,
      gemini: values.GATEWAY_TOKEN_GEMINI,
    },
    providers: {
      openai: providerSettings(values.OPENAI_API_KEY, values.OPENAI_MODEL, values.PROVIDER_TIMEOUT_MS),
      anthropic: providerSettings(
        values.ANTHROPIC_API_KEY,
        values.ANTHROPIC_MODEL,
        values.PROVIDER_TIMEOUT_MS,
      ),
      gemini: providerSettings(values.GEMINI_API_KEY, values.GEMINI_MODEL, values.PROVIDER_TIMEOUT_MS),
    },
    providerMaxOutputTokens: values.PROVIDER_MAX_OUTPUT_TOKENS,
    trustProxy: values.TRUST_PROXY,
    bodyLimitBytes: values.REQUEST_BODY_LIMIT_BYTES,
    limits: {
      requestsPerMinute: values.RATE_LIMIT_PER_MINUTE,
      authFailures: values.AUTH_FAILURE_LIMIT,
      providerCallsPerMinute: values.PROVIDER_CALLS_PER_MINUTE,
    },
    supabaseConfigured: values.SUPABASE_URL !== undefined,
    dashboardOrigin: values.DASHBOARD_ORIGIN,
    sessions: {
      max: values.MAX_SESSIONS,
      maxPerAgent: values.MAX_SESSIONS_PER_AGENT,
      idleTtlSeconds: values.SESSION_IDLE_TTL_SECONDS,
    },
    auditBufferSize: values.AUDIT_BUFFER_SIZE,
  };
}
