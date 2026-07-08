import { notifications } from "@mantine/notifications";
import { saveAs } from "file-saver";
import i18n from "@/i18n";

type RestrictedAction = "download" | "export" | "print";

// Natural-language i18n keys (present in en-US + zh-CN); other locales fall back.
const restrictedMessageKey: Record<RestrictedAction, string> = {
  download:
    "This download is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.",
  export:
    "This export is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.",
  print:
    "This print is blocked on the office network because the page, a subpage, or an attachment was created from the internal network.",
};

const restrictedMessage = (action: RestrictedAction) =>
  i18n.t(restrictedMessageKey[action]);

async function dataToMessage(data: unknown): Promise<string> {
  if (!data) return "";
  if (data instanceof Blob) {
    const text = await data.text().catch(() => "");
    try {
      const json = JSON.parse(text);
      return String(json?.message || json?.error || text || "");
    } catch {
      return text;
    }
  }
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    const value = data as { message?: unknown; error?: unknown };
    return String(value.message || value.error || "");
  }
  return "";
}

function isNetworkOriginMessage(message: string): boolean {
  return message.toLowerCase().includes("network origin");
}

export async function getNetworkOriginBlockedMessage(
  error: unknown,
  action: RestrictedAction,
): Promise<string | null> {
  const err = error as any;
  const status = err?.response?.status;
  const message = await dataToMessage(err?.response?.data);
  if (status === 403 && isNetworkOriginMessage(message)) {
    return restrictedMessage(action);
  }
  return null;
}

export async function notifyNetworkOriginBlocked(
  error: unknown,
  action: RestrictedAction,
): Promise<boolean> {
  const message = await getNetworkOriginBlockedMessage(error, action);
  if (!message) return false;
  notifications.show({ message, color: "red", position: "top-center" });
  return true;
}

function filenameFromDisposition(header: string | null): string | null {
  const raw = header?.split("filename=")[1]?.replace(/"/g, "");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function downloadWithNetworkOriginGuard(
  url: string,
  fallbackFileName = "download",
): Promise<void> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 403 && isNetworkOriginMessage(text)) {
      notifications.show({
        message: restrictedMessage("download"),
        color: "red",
        position: "top-center",
      });
      return;
    }
    notifications.show({ message: "Download failed", color: "red" });
    return;
  }

  const blob = await res.blob();
  saveAs(
    blob,
    filenameFromDisposition(res.headers.get("content-disposition")) ||
      fallbackFileName,
  );
}
