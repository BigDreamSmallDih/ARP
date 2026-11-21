import { createHash, timingSafeEqual } from 'node:crypto';

export type TokenDigest = Buffer;

export function digestToken(token: string): TokenDigest {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Compares fixed-length digests so the comparison time does not depend on the token contents. */
export function matchesDigest(candidate: string, expected: TokenDigest): boolean {
  return timingSafeEqual(digestToken(candidate), expected);
}

export function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer (\S+)$/i.exec(header);
  return match?.[1];
}
