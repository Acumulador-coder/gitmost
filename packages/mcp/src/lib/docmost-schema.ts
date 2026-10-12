/**
 * The Docmost schema for mcp: `docmostExtensions` and the sanitizers come from
 * `@docmost/prosemirror-markdown` (editor-ext's document extensions plus the
 * converter's parse overrides); `docmostSchema` is built from them once.
 */
import { getSchema } from "@tiptap/core";
import {
  docmostExtensions,
  clampCalloutType,
  sanitizeCssColor,
} from "@docmost/prosemirror-markdown";

export { docmostExtensions, clampCalloutType, sanitizeCssColor };

/**
 * The ProseMirror schema for the docmost editor, built ONCE from
 * `docmostExtensions`. Pure and reused by every consumer (diff, collaboration
 * write-back) so the schema can never drift between call sites.
 */
export const docmostSchema = getSchema(docmostExtensions);
