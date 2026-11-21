import type { Snapshot } from '../api/snapshot';
import { Card, Chip, ConnectionBanner, KeyValue } from '../components';
import { AuditTable } from './AuditTable';

export function Gateway({ snapshot, baseUrl }: { snapshot: Snapshot; baseUrl: string }) {
  const { gateway, audit, connection } = snapshot;
  const origin = baseUrl === '' ? window.location.origin : baseUrl;

  return (
    <div className="stack">
      <ConnectionBanner connection={connection} />

      {gateway !== undefined && (
        <>
          <Card title="Endpoint">
            <KeyValue
              rows={[
                ['Name', <span className="mono">{gateway.name}</span>],
                ['Version', gateway.version],
                ['Transport', 'Streamable HTTP (JSON responses)'],
                ['MCP URL', <span className="mono">{`${origin}${gateway.mcpPath}`}</span>],
                ['Authentication', 'Bearer token per agent'],
                [
                  'Sessions',
                  `${gateway.sessions.active} active of ${gateway.sessions.max}, idle timeout ${gateway.sessions.idleTtlSeconds}s`,
                ],
              ]}
            />
          </Card>

          <Card title="Tools">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Description</th>
                    <th>Permission</th>
                  </tr>
                </thead>
                <tbody>
                  {gateway.tools.map((tool) => (
                    <tr key={tool.name}>
                      <td className="mono">{tool.name}</td>
                      <td>{tool.description}</td>
                      <td>
                        <Chip>{tool.requiredPermission}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {audit !== undefined && (
        <Card title="Audit log" aside={<span className="muted small">in memory, newest first</span>}>
          <AuditTable events={audit} />
        </Card>
      )}
    </div>
  );
}
