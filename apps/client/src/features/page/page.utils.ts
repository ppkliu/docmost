import slugify from "@sindresorhus/slugify";
import { getPublicUrl } from "@/lib/config.ts";

const buildPageSlug = (pageSlugId: string, pageTitle?: string): string => {
  const titleSlug = slugify(pageTitle?.substring(0, 70) || "untitled", {
    customReplacements: [
      ["♥", ""],
      ["🦄", ""],
    ],
  });

  return `${titleSlug}-${pageSlugId}`;
};

export const buildPageUrl = (
  spaceName: string,
  pageSlugId: string,
  pageTitle?: string,
  anchorId?: string,
): string => {
  let url: string;
  if (spaceName === undefined) {
    url = `/p/${buildPageSlug(pageSlugId, pageTitle)}`;
  } else {
    url = `/s/${spaceName}/p/${buildPageSlug(pageSlugId, pageTitle)}`;
  }
  return anchorId ? `${url}#${anchorId}` : url;
};

export const buildSharedPageUrl = (opts: {
  shareId: string;
  pageSlugId: string;
  pageTitle?: string;
  anchorId?: string;
}): string => {
  const { shareId, pageSlugId, pageTitle, anchorId } = opts;
  let url: string;
  if (!shareId) {
    url = `/share/p/${buildPageSlug(pageSlugId, pageTitle)}`;
  } else {
    url = `/share/${shareId}/p/${buildPageSlug(pageSlugId, pageTitle)}`;
  }
  return anchorId ? `${url}#${anchorId}` : url;
};

// Whether copied/external share links carry the share key.
// true:  /share/{key}/p/{slug} - opens with the shared tree, search and branding
// false: /share/p/{slug}       - opens the single page only
const PUBLIC_SHARE_LINK_WITH_KEY = true;

// Absolute share link handed to people outside the app (copy / open in new tab).
// In-app share navigation keeps using buildSharedPageUrl so the key is preserved.
export const buildPublicShareLink = (opts: {
  shareId: string;
  pageSlugId: string;
  pageTitle?: string;
}): string =>
  getPublicUrl(
    buildSharedPageUrl({
      ...opts,
      shareId: PUBLIC_SHARE_LINK_WITH_KEY ? opts.shareId : undefined,
    }),
  );
