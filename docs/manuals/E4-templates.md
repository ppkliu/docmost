# E4 Templates

## Usage

1. Open Templates from the global sidebar.
2. Create a global template as a workspace admin, or create a space template for a space where you
   can write pages.
3. Edit the template content.
4. Use the template picker to create a page from the template.

## Automated Tests

```bash
pnpm --filter server test -- license-check.service.spec.ts
```

Recommended broader checks:

```bash
pnpm --filter server build
pnpm --filter client typecheck
```

## Manual Tests

1. Create a space-scoped template.
2. Add a heading, paragraph, and checklist to the template.
3. Use it inside the same space and verify a new page is created with the same content.
4. As a non-admin member, verify global template creation is forbidden.
5. Confirm `templates` appears in self-hosted OSS entitlements.
