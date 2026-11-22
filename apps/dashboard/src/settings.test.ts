import { describe, expect, it } from 'vitest';
import { DEFAULT_REFRESH_SECONDS, normalizeBaseUrl, parseRefreshSeconds } from './settings';

describe('normalizeBaseUrl', () => {
  it.each([
    ['', ''],
    ['   ', ''],
    ['https://gateway.example.com', 'https://gateway.example.com'],
    ['https://gateway.example.com/', 'https://gateway.example.com'],
    ['  http://localhost:8787  ', 'http://localhost:8787'],
    ['https://example.com/arp/', 'https://example.com/arp'],
    ['https://example.com/arp?x=1#frag', 'https://example.com/arp'],
  ])('normalises %j to %j', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it.each(['gateway.example.com', 'ftp://example.com', 'javascript:alert(1)', 'not a url'])(
    'rejects %j',
    (input) => {
      expect(normalizeBaseUrl(input)).toBeUndefined();
    },
  );
});

describe('parseRefreshSeconds', () => {
  it('accepts the offered choices as numbers or strings', () => {
    expect(parseRefreshSeconds(30)).toBe(30);
    expect(parseRefreshSeconds('60')).toBe(60);
  });

  it('falls back to the default for anything else', () => {
    for (const input of [0, 7, '7', 'abc', undefined, null, {}]) {
      expect(parseRefreshSeconds(input)).toBe(DEFAULT_REFRESH_SECONDS);
    }
  });
});
