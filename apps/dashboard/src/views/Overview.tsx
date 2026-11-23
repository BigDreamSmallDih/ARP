import type { Snapshot } from '../api/snapshot';
import { Badge, Card, ConnectionBanner, Notice, Stat } from '../components';
import { formatDateTime, formatUptime } from '../format';
import { providerPresentation } from '../present';
import { AuditTable } from './AuditTable';

export function Overview({ snapshot }: { snapshot: Snapshot }) {
  const { health, status, audit, connection } = snapshot;
  const connected = status?.providers.filter((provider) => provider.state === 'connected').length;

  return (
    <div className="stack">
      <ConnectionBanner connection={connection} />

      <div className="stat-grid">
        <Stat
          label="Gateway"
          value={health === undefined ? 'Unknown' : 'Reachable'}
          hint={health === undefined ? undefined : `v${health.version} · up ${formatUptime(health.uptimeSeconds)}`}
        />
        <Stat
          label="Active sessions"
          value={status === undefined ? '–' : `${status.sessions.active} / ${status.sessions.max}`}
          hint="MCP sessions held by agents"
        />
        <Stat
          label="MCP tools"
          value={status === undefined ? '–' : status.toolCount}
          hint="Registered on the gateway"
        />
        <Stat
          label="Providers connected"
          value={connected === undefined || status === undefined ? '–' : `${connected} / ${status.providers.length}`}
          hint="Last authenticated call succeeded"
        />
      </div>

      {status !== undefined && (
        <>
          {status.warnings.length > 0 && (
            <Notice tone="warn" title="Needs attention">
              {status.warnings.join(' ')}
            </Notice>
          )}

          <Card title="AI providers">
            <ul className="row-list">
              {status.providers.map((provider) => (
                <li key={provider.id}>
                  <span>
                    {provider.displayName}
                    {provider.model !== undefined && <span className="muted small mono"> {provider.model}</span>}
                  </span>
                  <Badge presentation={providerPresentation(provider.state)} />
                </li>
              ))}
            </ul>
            <p className="muted small">
              A provider shows as connected only after the gateway completed an authenticated call to it.
              Having an API key set is not enough.
            </p>
          </Card>

          <Card title="Roblox integration">
            <p>
              <span className="badge badge-muted">Not integrated</span>
            </p>
            <p className="muted small">
              No Roblox connection exists yet. It will be added only for experiences where integration is
              officially permitted.
            </p>
          </Card>
        </>
      )}

      {audit !== undefined && (
        <Card title="Recent audit events" aside={<span className="muted small">newest first</span>}>
          <AuditTable events={audit.slice(0, 6)} />
        </Card>
      )}

      {status !== undefined && (
        <p className="muted small">Gateway started {formatDateTime(status.startedAt)}</p>
      )}
    </div>
  );
}
