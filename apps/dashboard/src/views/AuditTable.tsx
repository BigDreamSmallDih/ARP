import type { AuditEvent } from '@arp/shared';
import { formatDateTime } from '../format';

function detail(event: AuditEvent): string {
  return [event.tool, event.reason, event.errorCode].filter((part) => part !== undefined).join(' · ');
}

export function AuditTable({ events }: { events: readonly AuditEvent[] }) {
  if (events.length === 0) {
    return <p className="muted">No audit events recorded since the gateway started.</p>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Outcome</th>
            <th>Agent</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id}>
              <td>{formatDateTime(event.timestamp)}</td>
              <td className="mono">{event.type}</td>
              <td>
                <span className={`badge badge-${event.outcome === 'success' ? 'info' : event.outcome === 'denied' ? 'warn' : 'danger'}`}>
                  {event.outcome}
                </span>
              </td>
              <td className="mono">{event.agentId ?? '–'}</td>
              <td className="mono">{detail(event) || '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
