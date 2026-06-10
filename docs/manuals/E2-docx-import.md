# E2 DOCX Import

## Usage

1. Open a space.
2. Use the page import flow.
3. Upload a `.docx` file.
4. Confirm Docmost creates a page from the document text and basic formatting.

The OSS implementation uses `mammoth` to convert DOCX to HTML, then reuses Docmost's existing
HTML import pipeline. Advanced layout fidelity is not guaranteed.

## Automated Tests

```bash
pnpm --filter server test -- import.service.spec.ts license-check.service.spec.ts
```

Expected:

- DOCX import calls the OSS `mammoth` converter.
- `import:docx` is included in self-hosted OSS entitlements.

## Manual Tests

1. Start Docmost with a self-hosted OSS build.
2. Log in as a user who can create pages in a space.
3. Import a DOCX containing a heading, paragraph, list, and link.
4. Verify the created page opens, can be edited, and saves normally.
5. Open browser devtools and confirm no "requires enterprise license" error appears.
