import { Editor } from "@tiptap/core";

// 讀取 Docmost 子路徑掛載前綴(如 /wiki),與 apps/client 的 getPublicPathPrefix 一致。
// editor-ext 在瀏覽器執行,由 server 注入的 window.CONFIG 取得;前綴為空時退化為原行為。
function getPublicPathPrefix(): string {
  const raw =
    (typeof window !== "undefined" &&
      (window as any)?.CONFIG?.DOCMOST_PUBLIC_PATH_PREFIX) ||
    "";
  if (!raw || raw === "/") return "";
  return "/" + raw.replace(/^\/+|\/+$/g, "");
}

export function normalizeFileUrl(src: string): string {
  if (!src) return "";
  // 外部 / blob / data URL 原樣返回
  if (/^(https?:|blob:|data:)/i.test(src)) return src;
  const prefix = getPublicPathPrefix();
  // 已帶前綴則不重複加
  if (prefix && src.startsWith(prefix + "/")) return src;
  if (src.startsWith("/files/")) return prefix + "/api" + src;
  if (src.startsWith("/api/")) return prefix + src;
  return src;
}

export type UploadFn = (
  file: File,
  editor: Editor,
  pos: number,
  pageId: string,
  // only applicable to file attachments
  allowMedia?: boolean,
) => void;

export interface MediaUploadOptions {
  validateFn?: (file: File, allowMedia?: boolean) => void;
  onUpload: (file: File, pageId: string) => Promise<any>;
}
