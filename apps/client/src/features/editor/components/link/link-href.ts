import { matchPath, type Params } from "react-router-dom";
import { INTERNAL_LINK_REGEX } from "@/lib/constants";
import { buildSharedPageUrl } from "@/features/page/page.utils.ts";
import { extractPageSlugId } from "@/lib";
// Client-local helpers, not @docmost/editor-ext: the app-wide LinkClickHost
// imports this module, and the editor-ext barrel would pull the whole TipTap
// engine into the startup graph.
import { sanitizeUrl } from "@/lib/sanitize-url";
import { normalizeUrl } from "@/lib/utils";

// The link host and the link mark's renderHTML both run outside <Routes>, so
// useParams() is not available to them; the route params are matched from the
// pathname instead.
const LINK_ROUTE_PATTERNS = [
  "/share/:shareId/p/:pageSlug",
  "/share/p/:pageSlug",
  "/s/:spaceSlug/p/:pageSlug",
];

export function matchLinkRoute(pathname: string): Params {
  for (const pattern of LINK_ROUTE_PATTERNS) {
    const match = matchPath(pattern, pathname);
    if (match) return match.params;
  }
  return {};
}

export const parseInternalLink = (
  href: string,
  internalAttr?: boolean,
): { isInternal: boolean; slugId: string | null; label: string } => {
  if (!href) return { isInternal: !!internalAttr, slugId: null, label: "" };

  const match = INTERNAL_LINK_REGEX.exec(href);
  if (!match) {
    if (internalAttr) return { isInternal: true, slugId: null, label: href };
    return { isInternal: false, slugId: null, label: href };
  }

  const isExternal = match[2] && match[2] !== window.location.host;
  const slug = match[5];
  const slugId = extractPageSlugId(slug);
  const namePart = slug.split("-").slice(0, -1).join("-");

  return {
    isInternal: !isExternal,
    slugId,
    label: namePart || slug,
  };
};

/**
 * The href a link actually points at in the UI: an internal link on a public
 * share route goes to the shared copy of the page (an anonymous visitor cannot
 * open the private app URL), an external one is normalized (`www.example.com`
 * would otherwise resolve as a relative path) — and both are sanitized.
 */
export function resolveLinkHref(opts: {
  href: string;
  isInternal: boolean;
  slugId: string | null;
  isShareRoute: boolean;
  shareId: string | undefined;
  pageTitle?: string;
}): string {
  const { href, isInternal, slugId, isShareRoute, shareId, pageTitle } = opts;
  return sanitizeUrl(
    isInternal
      ? isShareRoute && slugId
        ? buildSharedPageUrl({ shareId, pageSlugId: slugId, pageTitle })
        : href
      : normalizeUrl(href),
  );
}

/**
 * The absolute address of `href` when it resolves to this wiki's own origin,
 * otherwise null. Resolved with the URL parser, not by gluing the origin in
 * front of the href: `origin + ".evil.example/x"` reads as a wiki address but
 * points at another host. An href that does not parse is not an address on
 * this origin either.
 */
export function sameOriginLinkUrl(href: string): string | null {
  const origin = window.location.origin;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  return url.origin === origin ? url.href : null;
}

/**
 * The DOM attributes of a link mark's `<a>`, for the route at `pathname`. Only
 * attributes computed here reach the DOM: the document's own `class`, `rel`
 * and `target` are never rendered (a stored class can restyle the link into a
 * full-screen click trap), external links always open with
 * `noopener noreferrer nofollow`, and `title` is rendered as a plain attribute.
 */
export function linkDomAttributes(
  attrs: { href?: unknown; internal?: unknown; title?: unknown },
  pathname: string,
): Record<string, string> {
  const href = typeof attrs.href === "string" ? attrs.href : "";
  const internal = attrs.internal === true;
  const { isInternal, slugId } = parseInternalLink(href, internal);
  const dom: Record<string, string> = {
    href: resolveLinkHref({
      href,
      isInternal,
      slugId,
      isShareRoute: pathname.startsWith("/share"),
      shareId: matchLinkRoute(pathname).shareId,
    }),
  };
  if (internal) dom["data-internal"] = "true";
  if (!isInternal) {
    dom.target = "_blank";
    dom.rel = "noopener noreferrer nofollow";
  }
  if (typeof attrs.title === "string" && attrs.title) dom.title = attrs.title;
  return dom;
}
