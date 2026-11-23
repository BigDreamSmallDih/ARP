import { PermissionSchema, type Permission, type ProviderId } from '@arp/shared';

export interface AgentDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly provider: ProviderId;
  readonly permissions: readonly Permission[];
}

const READ_ONLY: readonly Permission[] = PermissionSchema.options.filter((permission) =>
  permission.endsWith(':read'),
);

/** Calling a provider is billable, so it is granted by name and not as part of the read set. */
const DEFAULT_PERMISSIONS: readonly Permission[] = [...READ_ONLY, 'providers:invoke'];

export const AGENT_ROSTER: readonly AgentDefinition[] = [
  { id: 'chatgpt', displayName: 'ChatGPT', provider: 'openai', permissions: DEFAULT_PERMISSIONS },
  { id: 'claude', displayName: 'Claude', provider: 'anthropic', permissions: DEFAULT_PERMISSIONS },
  { id: 'gemini', displayName: 'Gemini', provider: 'gemini', permissions: DEFAULT_PERMISSIONS },
];
