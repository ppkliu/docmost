import { renderInternalAttachmentNotice } from './internal-attachment-notice';

describe('renderInternalAttachmentNotice', () => {
  it('tells the user to connect to the internal network', () => {
    const html = renderInternalAttachmentNotice('合同.pdf');

    expect(html).toContain('该附件由内网上传，无法在外网下载。');
    expect(html).toContain('请连接内网后再打开或下载。');
    expect(html).toContain('合同.pdf');
  });

  it('escapes the file name', () => {
    const html = renderInternalAttachmentNotice(
      '<img src=x onerror=alert(1)>.pdf',
    );

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.pdf');
  });
});
