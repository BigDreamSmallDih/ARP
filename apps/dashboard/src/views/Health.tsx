import type { Snapshot } from '../api/snapshot';
import { Badge, Card, ConnectionBanner, KeyValue, Notice } from '../components';
import { formatDateTime, formatTime, formatUptime } from '../format';
import { componentPresentation } from '../present';

export function Health({ snapshot }: { snapshot: Snapshot }) {
  const { health, status, connection, refreshedAt } = snapshot;

  return (
    <div className="stack">
      <ConnectionBanner connection={connection} />

      <Card title="Health endpoint" aside={refreshedAt && <span className="muted small">checked {formatTime(refreshedAt)}</span>}>
        {health === undefined ? (
          <p className="muted">The health endpoint did not answer.</p>
        ) : (
          <KeyValue
            rows={[
              ['Status', <span className="badge badge-ok">{health.status}</span>],
              ['Version', health.version],
              ['Uptime', formatUptime(health.uptimeSeconds)],
              ['Server time', formatDateTime(health.timestamp)],
            ]}
          />
        )}
      </Card>

      {status !== undefined && (
        <>
          {status.warnings.length > 0 && (
            <Notice tone="warn" title="Needs attention">
              {status.warnings.join(' ')}
            </Notice>
          )}

          <Card title="Components">
            <ul className="row-list">
              <li>
                <span>Admin API</span>
                <Badge presentation={componentPresentation(status.components.adminApi)} />
              </li>
              <li>
                <span>Supabase</span>
                <span>
                  <Badge presentation={componentPresentation(status.components.supabase)} />{' '}
                  <span className="muted small">not used in Phase 1</span>
                </span>
              </li>
              <li>
                <span>Roblox</span>
                <span className="badge badge-muted">Not integrated</span>
              </li>
            </ul>
          </Card>

          <Card title="Runtime">
            <KeyValue
              rows={[
                ['Environment', status.environment],
                ['Node.js', status.nodeVersion],
                ['Started', formatDateTime(status.startedAt)],
                ['Sessions', `${status.sessions.active} / ${status.sessions.max}`],
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
