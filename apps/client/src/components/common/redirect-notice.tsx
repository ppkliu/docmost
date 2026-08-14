import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { consumeRedirectNotice } from "./redirect-notice.utils";

export function RedirectNotice() {
  const { t } = useTranslation();

  useEffect(() => {
    consumeRedirectNotice({
      href: window.location.href,
      show: (input) => notifications.show(input),
      replace: (url) => window.history.replaceState(null, "", url),
      translate: (key) => t(key),
    });
  }, [t]);

  return null;
}
