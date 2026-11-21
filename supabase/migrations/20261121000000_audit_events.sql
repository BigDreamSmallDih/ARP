-- Audit trail for the MCP gateway. Phase 1 keeps audit events in memory and does not
-- write to this table yet; the schema is here so persistence can be added without
-- reshaping the event model.

create table public.audit_events (
  id uuid primary key,
  occurred_at timestamptz not null,
  type text not null check (type in ('auth.failed', 'session.created', 'session.closed', 'tool.call')),
  outcome text not null check (outcome in ('success', 'denied', 'error')),
  agent_id text,
  session_id text,
  tool text,
  error_code text,
  reason text check (reason in ('client_closed', 'expired', 'shutdown')),
  request_id text
);

create index audit_events_occurred_at_idx on public.audit_events (occurred_at desc);
create index audit_events_agent_id_idx on public.audit_events (agent_id, occurred_at desc);

-- No policies on purpose: with row level security on and no policy, anon and
-- authenticated clients get no access. Only the gateway's service role key, which
-- bypasses RLS, can read or write this table.
alter table public.audit_events enable row level security;
