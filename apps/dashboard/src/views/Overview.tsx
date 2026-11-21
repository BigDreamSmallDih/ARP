import type { Snapshot } from '../api/snapshot';
import { Badge, Card, ConnectionBanner, Notice, Stat } from '../components';
import { formatDateTime, formatUptime } from '../format';
import { providerPresentation } from '../present';
import { AuditTable } from './AuditTable';

export function Overview({ snapshot }: { snapshot: Snapshot }) {
  const { health, status, audit, connection } = snapshot;
  const configured = status?.providers.filter((provider) => provider.state === 'configured').length;

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
          hint="Read-only demonstration tools"
        />
        <Stat
          label="Provider keys"
          value={configured === undefined || status === undefined ? '–' : `${configured} / ${status.providers.length}`}
          hint="Keys present, none verified"
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
                  <span>{provider.displayName}</span>
                  <Badge presentation={providerPresentation(provider.state)} />
                </li>
              ))}
            </ul>
            <p className="muted small">
              Provider adapters are placeholders. The gateway never calls a provider in this phase, so no
              provider can be shown as connected.
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
