import { describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, createClient } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const HEALTH = { status: 'ok', version: '0.1.0', uptimeSeconds: 12, timestamp: '2026-01-01T00:00:00.000Z' };

function clientWith(fetchImpl: typeof fetch, token: string | undefined) {
  return createClient({ baseUrl: 'https://gateway.example.com/', token, fetchImpl });
}

const TOKEN = 'admin-token';

describe('createClient', () => {
  it('requests the public health endpoint without credentials', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(HEALTH));
    await expect(clientWith(fetchImpl, TOKEN).health()).resolves.toEqual(HEALTH);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://gateway.example.com/health');
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends the bearer token on admin endpoints', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ agents: [] }));
    await expect(clientWith(fetchImpl, TOKEN).agents()).resolves.toEqual([]);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://gateway.example.com/api/agents');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer admin-token');
  });

  it('uses relative URLs when no base URL is set', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(HEALTH));
    await createClient({ baseUrl: '', token: undefined, fetchImpl }).health();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/health');
  });

  it('reports whether a token is present, treating an empty string as absent', () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(clientWith(fetchImpl, 'abc').hasToken).toBe(true);
    expect(clientWith(fetchImpl, '').hasToken).toBe(false);
    expect(clientWith(fetchImpl, undefined).hasToken).toBe(false);
  });

  it('turns a structured gateway error into an ApiError with its code', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: { code: 'unauthorized', message: 'Missing or invalid admin credential' } }, 401),
    );
    const failure = await clientWith(fetchImpl, TOKEN).status().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('rejects a body that does not match the schema', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ status: 'ok' }));
    const failure = await clientWith(fetchImpl, TOKEN).health().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'invalid_response' });
  });

  it('rejects a provider state the schema does not define', async () => {
    const agent = {
      id: 'claude',
      displayName: 'Claude',
      provider: 'anthropic',
      providerState: 'online',
      gatewayCredential: 'configured',
      permissions: [],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ agents: [agent] }));
    const failure = await clientWith(fetchImpl, TOKEN).agents().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'invalid_response' });
  });

  it('handles a non-JSON error page', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('Bad Gateway', { status: 502 }));
    const failure = await clientWith(fetchImpl, TOKEN).health().catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 502, code: 'invalid_response' });
  });

  it('wraps fetch failures in a NetworkError', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const failure = await clientWith(fetchImpl, TOKEN).health().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NetworkError);
  });
});
