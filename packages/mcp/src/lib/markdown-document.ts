/**
 * Self-contained Docmost-flavoured Markdown document envelope (`docmost:meta` /
 * `docmost:comments` blocks).
 *
 * This envelope is owned by the shared `@docmost/prosemirror-markdown` package;
 * this file is a thin re-export shim so the `./markdown-document.js` importers
 * (client.ts, tests) do not move.
 */
export {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
  serializeDocmostMarkdownBody,
} from "@docmost/prosemirror-markdown";
export type { DocmostMdMeta } from "@docmost/prosemirror-markdown";
