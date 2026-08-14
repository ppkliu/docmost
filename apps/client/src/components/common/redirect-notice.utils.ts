type NoticeInput = {
  message: string;
  color: "red";
};

type ConsumeRedirectNoticeInput = {
  href: string;
  show: (input: NoticeInput) => void;
  replace: (url: string) => void;
  translate: (key: string) => string;
};

const NOTICE_KEYS: Record<string, string> = {
  "space-forbidden": "redirectNotice.spaceForbidden",
  "page-forbidden": "redirectNotice.pageForbidden",
  "space-invalid": "redirectNotice.spaceInvalid",
  "space-not-found": "redirectNotice.spaceNotFound",
  "page-invalid": "redirectNotice.pageInvalid",
  "page-not-found": "redirectNotice.pageNotFound",
  "page-space-mismatch": "redirectNotice.pageSpaceMismatch",
  "grant-apply-failed": "redirectNotice.grantApplyFailed",
  "sso-invalid": "redirectNotice.ssoInvalid",
  "sso-unavailable": "redirectNotice.ssoUnavailable",
  "sso-failed": "redirectNotice.ssoFailed",
};

export function consumeRedirectNotice({
  href,
  show,
  replace,
  translate,
}: ConsumeRedirectNoticeInput): boolean {
  const url = new URL(href);
  const notice = url.searchParams.get("notice");
  const translationKey = notice ? NOTICE_KEYS[notice] : undefined;
  if (!translationKey) return false;

  show({ message: translate(translationKey), color: "red" });
  url.searchParams.delete("notice");
  replace(`${url.pathname}${url.search}${url.hash}`);
  return true;
}
