import { GatewayError, type Permission } from '@arp/shared';

export function hasPermission(granted: readonly Permission[], required: Permission): boolean {
  return granted.includes(required);
}

export function assertPermission(
  agentId: string,
  granted: readonly Permission[],
  required: Permission,
): void {
  if (!hasPermission(granted, required)) {
    throw new GatewayError(
      'permission_denied',
      `Agent "${agentId}" does not have the "${required}" permission`,
    );
  }
}
