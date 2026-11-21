import { z } from 'zod';

export const PermissionSchema = z.enum([
  'system:read',
  'agents:read',
  'gateway:read',
  'session:read',
]);

export type Permission = z.infer<typeof PermissionSchema>;
