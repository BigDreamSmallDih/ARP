import { digestToken, matchesDigest, type TokenDigest } from '@arp/security';
import type { AgentSummary, Permission, ProviderId } from '@arp/shared';
import type { ProviderAdapter } from './providers';
import type { AgentDefinition } from './roster';

export interface AgentIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly permissions: readonly Permission[];
}

export class AgentRegistry {
  private readonly roster: readonly AgentDefinition[];
  private readonly adapters: Readonly<Record<ProviderId, ProviderAdapter>>;
  private readonly digests = new Map<string, TokenDigest>();

  constructor(
    roster: readonly AgentDefinition[],
    tokens: Readonly<Record<string, string | undefined>>,
    adapters: Readonly<Record<ProviderId, ProviderAdapter>>,
  ) {
    this.roster = roster;
    this.adapters = adapters;

    const seenIds = new Set<string>();
    const seenDigests = new Set<string>();
    for (const agent of roster) {
      if (seenIds.has(agent.id)) {
        throw new Error(`Duplicate agent id "${agent.id}" in the roster`);
      }
      seenIds.add(agent.id);

      const token = tokens[agent.id];
      if (token === undefined || token === '') continue;

      const digest = digestToken(token);
      const fingerprint = digest.toString('hex');
      if (seenDigests.has(fingerprint)) {
        throw new Error(`Agent "${agent.id}" shares a gateway token with another agent`);
      }
      seenDigests.add(fingerprint);
      this.digests.set(agent.id, digest);
    }
  }

  /** Checks every agent so the work done does not reveal which one matched. */
  authenticate(token: string): AgentIdentity | undefined {
    let match: AgentDefinition | undefined;
    for (const agent of this.roster) {
      const digest = this.digests.get(agent.id);
      if (digest !== undefined && matchesDigest(token, digest)) match = agent;
    }
    return match === undefined ? undefined : toIdentity(match);
  }

  get(id: string): AgentSummary | undefined {
    const agent = this.roster.find((candidate) => candidate.id === id);
    return agent === undefined ? undefined : this.summarize(agent);
  }

  list(provider?: ProviderId): AgentSummary[] {
    return this.roster
      .filter((agent) => provider === undefined || agent.provider === provider)
      .map((agent) => this.summarize(agent));
  }

  private summarize(agent: AgentDefinition): AgentSummary {
    return {
      id: agent.id,
      displayName: agent.displayName,
      provider: agent.provider,
      providerState: this.adapters[agent.provider].status().state,
      gatewayCredential: this.digests.has(agent.id) ? 'configured' : 'missing',
      permissions: [...agent.permissions],
    };
  }
}

function toIdentity(agent: AgentDefinition): AgentIdentity {
  return {
    id: agent.id,
    displayName: agent.displayName,
    permissions: agent.permissions,
  };
}
