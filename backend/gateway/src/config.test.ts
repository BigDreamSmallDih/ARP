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
    });
    expect(config.providerKeysPresent).toEqual({ openai: false, anthropic: false, gemini: false });
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
    expect(config.providerKeysPresent.openai).toBe(false);
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

  it('records only whether provider keys exist, never their values', () => {
    const apiKey = 'sk-test-this-value-must-not-be-kept';
    const config = loadConfig({ OPENAI_API_KEY: apiKey, ANTHROPIC_API_KEY: apiKey });
    expect(config.providerKeysPresent).toEqual({ openai: true, anthropic: true, gemini: false });
    expect(JSON.stringify(config)).not.toContain(apiKey);
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['MAX_SESSIONS', '0'],
    ['MAX_SESSIONS_PER_AGENT', '0'],
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
