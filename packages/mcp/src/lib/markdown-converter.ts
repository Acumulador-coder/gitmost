/**
 * ProseMirror -> Docmost-flavoured Markdown converter.
 *
 * The converter CORE lives in the shared `@docmost/prosemirror-markdown`
 * package (the canonical, lossless implementation). This file is a thin
 * re-export shim so the `./markdown-converter.js` importers (client.ts, tests)
 * do not have to move.
 */
export {
  convertProseMirrorToMarkdown,
  type ConvertProseMirrorToMarkdownOptions,
} from "@docmost/prosemirror-markdown";
