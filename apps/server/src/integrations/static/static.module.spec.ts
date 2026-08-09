import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  applyAppNameToIndexHtml,
  applyKbWidgetToIndexHtml,
  KB_WIDGET_MARKER,
  readFreshIndexTemplate,
} from './static.module';

describe('applyAppNameToIndexHtml', () => {
  const html = [
    '<title>stale brand</title>',
    '<meta name="apple-mobile-web-app-title" content="stale brand" />',
  ].join('\n');

  it('applies the runtime app name before the client loads', () => {
    const transformed = applyAppNameToIndexHtml(html, 'WIKI');

    expect(transformed).toContain('<title>WIKI</title>');
    expect(transformed).toContain(
      '<meta name="apple-mobile-web-app-title" content="WIKI" />',
    );
    expect(transformed).not.toContain('stale brand');
  });

  it('escapes an app name before inserting it into HTML', () => {
    const transformed = applyAppNameToIndexHtml(html, 'R&D <Wiki>');

    expect(transformed).toContain('<title>R&amp;D &lt;Wiki&gt;</title>');
  });

  it('keeps the build-time fallback when APP_NAME is blank', () => {
    expect(applyAppNameToIndexHtml(html, '   ')).toBe(html);
  });
});

describe('readFreshIndexTemplate', () => {
  let directory: string;
  let indexFile: string;
  let templateFile: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(join(os.tmpdir(), 'docmost-static-'));
    indexFile = join(directory, 'index.html');
    templateFile = join(directory, 'index-template.html');
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('refreshes a stale template when index.html comes from a new build', () => {
    fs.writeFileSync(templateFile, '<script src="/assets/old.js"></script>');
    fs.writeFileSync(
      indexFile,
      '<!--window-config--><script src="/assets/new.js"></script>',
    );

    const html = readFreshIndexTemplate(
      indexFile,
      templateFile,
      '<!--window-config-->',
    );

    expect(html).toContain('/assets/new.js');
    expect(fs.readFileSync(templateFile, 'utf8')).toBe(html);
  });

  it('reuses the clean template after the runtime index was transformed', () => {
    fs.writeFileSync(templateFile, '<!--window-config--><main>app</main>');
    fs.writeFileSync(
      indexFile,
      '<script>window.CONFIG={}</script><main>app</main>',
    );

    expect(
      readFreshIndexTemplate(indexFile, templateFile, '<!--window-config-->'),
    ).toBe('<!--window-config--><main>app</main>');
  });
});

describe('applyKbWidgetToIndexHtml', () => {
  const html = `<body><div id="root"></div>${KB_WIDGET_MARKER}</body>`;

  it('injects the widget script when a URL is configured', () => {
    const out = applyKbWidgetToIndexHtml(html, '/kb-widget.js');

    expect(out).toContain('<script src="/kb-widget.js" defer></script>');
    expect(out).not.toContain(KB_WIDGET_MARKER);
  });

  // Unset must be byte-for-byte the pre-feature page: deployments without a
  // knowledge base should not be able to tell this feature was ever added.
  it('drops the placeholder when no URL is configured', () => {
    expect(applyKbWidgetToIndexHtml(html, undefined)).toBe(
      '<body><div id="root"></div></body>',
    );
    expect(applyKbWidgetToIndexHtml(html, '   ')).toBe(
      '<body><div id="root"></div></body>',
    );
  });

  it('escapes the URL before it lands in an attribute', () => {
    const out = applyKbWidgetToIndexHtml(html, '/x.js" onload="alert(1)');

    expect(out).not.toContain('onload="alert(1)"');
    expect(out).toContain('&quot;');
  });
});
