import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';
import { testToken } from './test-support';

function issuesOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues;
  }
  throw new Error('Expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies safe defaults from an empty environment', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      environment: 'development',
      host: '127.0.0.1',
      port: 8787,
      logLevel: 'info',
      adminToken: undefined,
      supabaseConfigured: false,
      dashboardOrigin: undefined,
      sessions: { max: 100, idleTtlSeconds: 1800 },
      auditBufferSize: 500,
      trustProxy: false,
      bodyLimitBytes: 262_144,
      providerMaxOutputTokens: 1_024,
      limits: { requestsPerMinute: 120, authFailures: 10, providerCallsPerMinute: 20 },
    });
    for (const provider of Object.values(config.providers)) {
      expect(provider).toMatchObject({ apiKey: undefined, model: undefined, timeoutMs: 30_000 });
    }
  });

  it('treats empty strings as unset, as in a copied .env.example', () => {
    const config = loadConfig({
      PORT: '',
      GATEWAY_ADMIN_TOKEN: '',
      GATEWAY_TOKEN_CLAUDE: '   ',
      OPENAI_API_KEY: '',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    });
    expect(config.port).toBe(8787);
    expect(config.adminToken).toBeUndefined();
    expect(config.agentTokens.claude).toBeUndefined();
    expect(config.providers.openai.apiKey).toBeUndefined();
  });

  it('reads explicit values', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '9000',
      LOG_LEVEL: 'warn',
      GATEWAY_ADMIN_TOKEN: testToken('admin'),
      GATEWAY_TOKEN_GEMINI: testToken('gemini'),
      SESSION_IDLE_TTL_SECONDS: '60',
      MAX_SESSIONS: '5',
      MAX_SESSIONS_PER_AGENT: '2',
    });
    expect(config).toMatchObject({
      environment: 'production',
      host: '0.0.0.0',
      port: 9000,
      logLevel: 'warn',
      sessions: { max: 5, maxPerAgent: 2, idleTtlSeconds: 60 },
    });
    expect(config.agentTokens.gemini).toBe(testToken('gemini'));
  });

  it('holds provider keys as secrets that do not survive serialisation or inspection', () => {
    const apiKey = 'sk-test-this-value-must-not-be-kept';
    const config = loadConfig({
      OPENAI_API_KEY: apiKey,
      OPENAI_MODEL: 'model-a',
      ANTHROPIC_API_KEY: apiKey + '2',
    });

    expect(config.providers.openai.apiKey?.reveal()).toBe(apiKey);
    expect(config.providers.openai.model).toBe('model-a');
    expect(config.providers.anthropic.model).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain(apiKey);
    expect(inspect(config, { depth: 6 })).not.toContain(apiKey);
    expect(String(config.providers.openai.apiKey)).not.toContain(apiKey);
  });

  it('reads limits, proxy trust and timeouts', () => {
    const config = loadConfig({
      TRUST_PROXY: 'true',
      REQUEST_BODY_LIMIT_BYTES: '4096',
      RATE_LIMIT_PER_MINUTE: '30',
      AUTH_FAILURE_LIMIT: '3',
      PROVIDER_CALLS_PER_MINUTE: '5',
      PROVIDER_TIMEOUT_MS: '5000',
      PROVIDER_MAX_OUTPUT_TOKENS: '256',
    });
    expect(config).toMatchObject({
      trustProxy: true,
      bodyLimitBytes: 4096,
      limits: { requestsPerMinute: 30, authFailures: 3, providerCallsPerMinute: 5 },
      providerMaxOutputTokens: 256,
    });
    expect(config.providers.gemini.timeoutMs).toBe(5000);
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['MAX_SESSIONS', '0'],
    ['MAX_SESSIONS_PER_AGENT', '0'],
    ['TRUST_PROXY', 'yes'],
    ['PROVIDER_TIMEOUT_MS', '10'],
    ['PROVIDER_MAX_OUTPUT_TOKENS', '100000'],
    ['REQUEST_BODY_LIMIT_BYTES', '10'],
    ['RATE_LIMIT_PER_MINUTE', '0'],
    ['AUTH_FAILURE_LIMIT', '0'],
    ['PROVIDER_CALLS_PER_MINUTE', '0'],
    ['OPENAI_MODEL', 'name with spaces'],
    ['GEMINI_MODEL', '../evil'],
    ['SESSION_IDLE_TTL_SECONDS', '5'],
    ['AUDIT_BUFFER_SIZE', '-1'],
    ['DASHBOARD_ORIGIN', 'not a url'],
    ['SUPABASE_URL', 'not a url'],
  ])('rejects %s=%s', (name, value) => {
    const issues = issuesOf({ [name]: value });
    expect(issues.some((issue) => issue.startsWith(`${name}:`))).toBe(true);
  });

  it('rejects short secrets without echoing them', () => {
    const shortToken = 'short-secret-value';
    const issues = issuesOf({ GATEWAY_ADMIN_TOKEN: shortToken });
    expect(issues).toEqual(['GATEWAY_ADMIN_TOKEN: must be at least 32 characters']);
    expect(issues.join('\n')).not.toContain(shortToken);
  });

  it('requires the Supabase URL and service key together', () => {
    expect(issuesOf({ SUPABASE_URL: 'https://example.supabase.co' })).toEqual([
      'SUPABASE_URL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set together',
    ]);
    expect(issuesOf({ SUPABASE_SERVICE_ROLE_KEY: 'service-key' })).toHaveLength(1);
    expect(
      loadConfig({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-key',
      }).supabaseConfigured,
    ).toBe(true);
  });

  it('rejects the same token used for two credentials', () => {
    const shared = testToken('shared');
    const issues = issuesOf({
      GATEWAY_ADMIN_TOKEN: shared,
      GATEWAY_TOKEN_CLAUDE: shared,
    });
    expect(issues).toEqual(['GATEWAY_TOKEN_CLAUDE: must differ from GATEWAY_ADMIN_TOKEN']);
  });

  it('never repeats a rejected value in its messages, even for enum fields', () => {
    const pasted = 'sk-live-pasted-on-the-wrong-line-9876543210';
    const issues = issuesOf({ LOG_LEVEL: pasted, NODE_ENV: pasted, TRUST_PROXY: pasted });
    expect(issues).toHaveLength(3);
    expect(issues.join('\n')).not.toContain(pasted);
    expect(issues[0]).toContain('must be one of');
  });

  it('reports every problem at once', () => {
    const issues = issuesOf({ PORT: 'abc', LOG_LEVEL: 'verbose', MAX_SESSIONS: '0' });
    expect(issues).toHaveLength(3);
  });

  it('normalises the dashboard origin', () => {
    expect(loadConfig({ DASHBOARD_ORIGIN: 'https://dash.example.com/some/path/' }).dashboardOrigin).toBe(
      'https://dash.example.com',
    );
  });

  it('formats the error message with one line per issue', () => {
    try {
      loadConfig({ PORT: 'abc' });
      throw new Error('Expected loadConfig to throw');
    } catch (error) {
      expect((error as Error).message).toMatch(/^Invalid configuration:\n {2}- PORT: /);
    }
  });
});
