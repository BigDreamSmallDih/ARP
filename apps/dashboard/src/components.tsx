import type { ReactNode } from 'react';
import { connectionNotice, type Presentation, type Tone } from './present';
import type { ConnectionState } from './api/snapshot';

export function Badge({ presentation }: { presentation: Presentation }) {
  return <span className={`badge badge-${presentation.tone}`}>{presentation.label}</span>;
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

export function Card({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <header className="card-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint !== undefined && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function Notice({ tone, title, children }: { tone: Tone; title: string; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function ConnectionBanner({ connection }: { connection: ConnectionState }) {
  if (connection.kind === 'loading') return <p className="muted">Loading…</p>;
  const notice = connectionNotice(connection);
  if (notice === undefined) return null;
  return (
    <Notice tone={notice.tone} title={notice.title}>
      {notice.body}
    </Notice>
  );
}

export function KeyValue({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([key, value]) => (
        <div key={key} className="kv-row">
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
