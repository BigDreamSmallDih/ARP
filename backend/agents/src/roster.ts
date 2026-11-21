import { PermissionSchema, type Permission, type ProviderId } from '@arp/shared';

export interface AgentDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly provider: ProviderId;
  readonly permissions: readonly Permission[];
}

/** Every Phase 1 permission is read-only, so each agent gets all of them. */
const READ_ONLY: readonly Permission[] = PermissionSchema.options;

export const AGENT_ROSTER: readonly AgentDefinition[] = [
  { id: 'chatgpt', displayName: 'ChatGPT', provider: 'openai', permissions: READ_ONLY },
  { id: 'claude', displayName: 'Claude', provider: 'anthropic', permissions: READ_ONLY },
  { id: 'gemini', displayName: 'Gemini', provider: 'gemini', permissions: READ_ONLY },
];
