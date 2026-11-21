# Supabase

Phase 1 only lays the groundwork. The gateway does not connect to Supabase yet.

- `migrations/` holds SQL that is ready to apply but has not been applied to any project.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are validated by the gateway configuration and
  reported as configured or unconfigured on the dashboard. Nothing reads them beyond that.
- The service role key bypasses row level security. It belongs only in the gateway's server
  environment, never in the dashboard or any client bundle.

## Applying the migration

Apply it from the Supabase SQL editor, or with the Supabase CLI once a project is linked:

```sh
supabase db push
```

Review the SQL first. It creates `public.audit_events` with row level security enabled and no
policies, so only the service role can touch it.

## What comes next

Phase 2 can add a small writer that mirrors the in-memory audit log into `audit_events`. The
column set matches the `AuditEvent` schema in `packages/shared`.
