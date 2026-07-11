import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { readFreshIndexTemplate } from './static.module';

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
