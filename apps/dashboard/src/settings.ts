export const REFRESH_CHOICES = [5, 10, 30, 60] as const;

export interface Settings {
  readonly baseUrl: string;
  readonly token: string;
  readonly refreshSeconds: number;
}

export const DEFAULT_REFRESH_SECONDS = 10;

/** Returns '' for same origin, the cleaned URL for http(s) input, and undefined when invalid. */
export function normalizeBaseUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function parseRefreshSeconds(input: unknown): number {
  const value = typeof input === 'string' ? Number(input) : input;
  return REFRESH_CHOICES.find((choice) => choice === value) ?? DEFAULT_REFRESH_SECONDS;
}
