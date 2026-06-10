# E3 Audit Logs

## Usage

Workspace owners can open Settings → Audit logs to review workspace events.

The OSS implementation records calls made through the existing `AuditService` integration into the
`audit` table and exposes:

- `POST /api/audit`
- `POST /api/audit/retention`
- `POST /api/audit/retention/update`

## Automated Tests

```bash
pnpm --filter server test -- license-check.service.spec.ts
```

Recommended broader checks:

```bash
pnpm --filter server build
pnpm --filter server lint
```

## Manual Tests

1. Start Docmost and log in as a workspace owner.
2. Create or update a page/space/user setting that calls `AuditService`.
3. Open Settings → Audit logs.
4. Verify the event appears with event name, actor, timestamp, and resource metadata.
5. Log in as a non-owner and verify audit logs are forbidden.
