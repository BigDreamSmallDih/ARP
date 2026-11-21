import type { Snapshot } from '../api/snapshot';
import { Badge, Card, Chip, ConnectionBanner } from '../components';
import { credentialPresentation, providerPresentation } from '../present';

export function Agents({ snapshot }: { snapshot: Snapshot }) {
  const { agents, connection } = snapshot;

  return (
    <div className="stack">
      <ConnectionBanner connection={connection} />

      {agents !== undefined && (
        <div className="card-grid">
          {agents.map((agent) => (
            <Card key={agent.id} title={agent.displayName} aside={<span className="mono muted small">{agent.id}</span>}>
              <div className="kv">
                <div className="kv-row">
                  <dt>Provider</dt>
                  <dd>
                    <span className="mono">{agent.provider}</span>{' '}
                    <Badge presentation={providerPresentation(agent.providerState)} />
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>Gateway credential</dt>
                  <dd>
                    <Badge presentation={credentialPresentation(agent.gatewayCredential)} />
                  </dd>
                </div>
                <div className="kv-row">
                  <dt>Permissions</dt>
                  <dd className="chips">
                    {agent.permissions.map((permission) => (
                      <Chip key={permission}>{permission}</Chip>
                    ))}
                  </dd>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <p className="muted small">
        "Key set, not verified" means the gateway environment holds an API key for the provider. Phase 1
        never sends it anywhere. "Token set" means the agent can authenticate to the MCP gateway.
      </p>
    </div>
  );
}
