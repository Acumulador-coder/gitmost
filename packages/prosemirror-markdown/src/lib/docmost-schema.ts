/**
 * The Docmost schema for the converter: editor-ext's `documentExtensions` with the
 * parse rules and defaults the markdown round-trip depends on, plus the import
 * sanitizers `clampCalloutType` and `sanitizeCssColor`.
 */
import { fromString } from "@tiptap/core";
import {
  documentExtensions,
  encodeHtmlEmbedSource,
  decodeHtmlEmbedSource,
  validCalloutTypes,
} from "@docmost/editor-ext";

export { encodeHtmlEmbedSource, decodeHtmlEmbedSource };

// Inlined from @tiptap/core's getStyleProperty (added after 3.20.x). Reads one
// declaration from an element's inline `style` attribute, last-wins, case-insensitive.
function getStyleProperty(element: HTMLElement, propertyName: string): string | null {
  const styleAttr = element.getAttribute("style");
  if (!styleAttr) {
    return null;
  }
  const decls = styleAttr.split(";").map((decl) => decl.trim()).filter(Boolean);
  const target = propertyName.toLowerCase();
  for (let i = decls.length - 1; i >= 0; i -= 1) {
    const decl = decls[i];
    const colonIndex = decl.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const prop = decl.slice(0, colonIndex).trim().toLowerCase();
    if (prop === target) {
      return decl.slice(colonIndex + 1).trim();
    }
  }
  return null;
}

// GitHub/Obsidian alert names that are not schema types, mapped to the closest banner.
const CALLOUT_TYPE_ALIASES: Record<string, string> = {
  tip: "success",
  caution: "danger",
  important: "info",
};
export const clampCalloutType = (value: string | null | undefined): string => {
  if (!value) return "info";
  const lower = value.toLowerCase();
  // A real schema type round-trips to itself (idempotent).
  if (validCalloutTypes.includes(lower)) return lower;
  // A known GitHub/Obsidian alias maps to the editor's closest banner.
  if (CALLOUT_TYPE_ALIASES[lower]) return CALLOUT_TYPE_ALIASES[lower];
  // Anything else is collapsed to the safe default (matches the editor).
  return "info";
};

// Mark colors are interpolated into an inline style, so only a narrow subset of
// CSS <color> syntax is accepted: named colors, hex, rgb()/rgba()/hsl()/hsla().
const SAFE_COLOR_RE =
  /^(?:[a-zA-Z]+|#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\))$/;
export const sanitizeCssColor = (
  value: string | null | undefined,
): string | null => {
  if (typeof value !== "string") return null;
  const color = value.trim();
  return color && SAFE_COLOR_RE.test(color) ? color : null;
};

type AttrPatch = Record<string, unknown>;

// Extends an editor-ext extension, merging each patch into the inherited attribute spec.
const patchAttrs = (ext: any, patches: Record<string, AttrPatch>) =>
  ext.extend({
    addAttributes(this: any) {
      const attrs = { ...(this.parent?.() ?? {}) };
      for (const [name, patch] of Object.entries(patches)) {
        attrs[name] = { ...attrs[name], ...patch };
      }
      return attrs;
    },
  });

// Reads a stored URL verbatim. The editor's parse filters URLs for pasted HTML
// (sanitizeUrl normalizes them, audio/pdf keep only internal files), which would
// rewrite or drop the value on every round-trip.
const verbatim = (attr: string): AttrPatch => ({
  parseHTML: (el: HTMLElement) => el.getAttribute(attr),
});

const OVERRIDES: Record<string, (ext: any) => any> = {
  // The importer writes `> [!alias]` names as-is; map them onto a real callout type.
  callout: (ext) =>
    patchAttrs(ext, {
      type: { parseHTML: (el: HTMLElement) => clampCalloutType(el.getAttribute("data-callout-type")) },
    }),
  // Imported colors are untrusted markdown HTML; accept only a safe CSS color.
  highlight: (ext) =>
    patchAttrs(ext, {
      color: {
        parseHTML: (el: HTMLElement) =>
          sanitizeCssColor(
            el.getAttribute("data-color") ||
              getStyleProperty(el, "background-color") ||
              el.style.backgroundColor,
          ),
      },
    }),
  // Text color is a global attribute that the Color extension adds to textStyle;
  // it is interpolated into an inline style too, so it gets the same allowlist.
  color: (ext) =>
    ext.extend({
      addGlobalAttributes(this: any) {
        return (this.parent?.() ?? []).map((group: any) => ({
          ...group,
          attributes: {
            ...group.attributes,
            color: {
              ...group.attributes?.color,
              parseHTML: (el: HTMLElement) =>
                sanitizeCssColor(getStyleProperty(el, "color") || el.style.color),
            },
          },
        }));
      },
    }),
  // The converter carries LaTeX in a `text` attribute; the editor reads innerHTML.
  mathInline: (ext) =>
    patchAttrs(ext, { text: { parseHTML: (el: HTMLElement) => el.getAttribute("text") } }),
  mathBlock: (ext) =>
    patchAttrs(ext, { text: { parseHTML: (el: HTMLElement) => el.getAttribute("text") } }),
  // The converter writes image alignment as `align=`; marked emits `alt=""` for `![](src)`.
  image: (ext) =>
    patchAttrs(ext, {
      align: { parseHTML: (el: HTMLElement) => el.getAttribute("align") },
      alt: { parseHTML: (el: HTMLElement) => el.getAttribute("alt") || null },
    }),
  audio: (ext) => patchAttrs(ext, { src: verbatim("src") }),
  embed: (ext) => patchAttrs(ext, { src: verbatim("data-src") }),
  attachment: (ext) => patchAttrs(ext, { url: verbatim("data-attachment-url") }),
  // Null width/height defaults: the exporter writes any non-null value, so a
  // default would be added to every pdf on import.
  pdf: (ext) =>
    patchAttrs(ext, {
      src: verbatim("src"),
      width: { default: null },
      height: { default: null },
    }),
  // The converter emits `div[data-type="youtube"]` with data-* attributes; null
  // width/height defaults for the same reason as pdf.
  youtube: (ext) =>
    patchAttrs(ext, {
      src: verbatim("data-src"),
      width: { default: null, parseHTML: (el: HTMLElement) => fromString(el.getAttribute("data-width")) },
      height: { default: null, parseHTML: (el: HTMLElement) => fromString(el.getAttribute("data-height")) },
    }).extend({
      parseHTML() {
        return [{ tag: 'div[data-type="youtube"]' }];
      },
    }),
};

// The extension names the converter patches; each must name an extension in
// editor-ext's `documentExtensions` (pinned by docmost-schema-parity.test.ts).
export const OVERRIDE_EXTENSION_NAMES = Object.keys(OVERRIDES);

export const docmostExtensions = (documentExtensions as any[]).map(
  (ext) => OVERRIDES[ext.name]?.(ext) ?? ext,
);
