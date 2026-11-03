/**
 * Shown instead of the bare 403 JSON when a browser opens an internal-network
 * attachment from the office network (design §12): an embedded PDF preview, a
 * search-result download in a new tab, or a pasted link. Programmatic callers
 * (the in-app download button, the adapter) do not ask for text/html and keep
 * the JSON body their error handling already matches on.
 */
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ],
  );

export function renderInternalAttachmentNotice(fileName: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>内网附件</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f4f5f7; color: #374151;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif; }
  .card { max-width: 420px; margin: 16px; padding: 32px 28px; text-align: center; background: #fff;
    border: 2px dashed #c4c9d2; border-radius: 12px; }
  h1 { margin: 16px 0 8px; font-size: 20px; }
  p { margin: 6px 0; font-size: 15px; color: #6b7280; line-height: 1.6; }
  .file { margin-top: 14px; font-size: 13px; color: #9ca3af; word-break: break-all; }
</style>
</head>
<body>
<div class="card">
<svg width="56" height="56" viewBox="-36 -30 72 76" fill="none" stroke="#6b7280" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
<rect x="-30" y="-6" width="60" height="46" rx="6" fill="#e5e7eb"/>
<path d="M-18 -6v-12a18 18 0 0 1 36 0v12"/>
<circle cx="0" cy="17" r="4" fill="#6b7280" stroke="none"/>
</svg>
<h1>内网附件</h1>
<p>该附件由内网上传，无法在外网下载。</p>
<p>请连接内网后再打开或下载。</p>
<div class="file">${escapeHtml(fileName)}</div>
</div>
</body>
</html>
`;
}
