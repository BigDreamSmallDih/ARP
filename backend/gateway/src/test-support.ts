import { loadConfig, type GatewayConfig } from './config';

/** Obviously fake 40-character credentials for tests. */
export function testToken(label: string): string {
  return `${label}-`.padEnd(40, 'x');
}

export function testConfig(overrides: Record<string, string> = {}): GatewayConfig {
  return loadConfig({
    NODE_ENV: 'test',
    GATEWAY_ADMIN_TOKEN: testToken('admin'),
    GATEWAY_TOKEN_CHATGPT: testToken('chatgpt'),
    GATEWAY_TOKEN_CLAUDE: testToken('claude'),
    ...overrides,
  });
}
