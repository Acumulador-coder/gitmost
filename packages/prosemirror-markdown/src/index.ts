/**
 * Public surface of `@docmost/prosemirror-markdown`.
 *
 * A headless ProseMirror <-> Markdown converter over the Docmost schema
 * (editor-ext's `documentExtensions` plus the converter's `OVERRIDES`).
 * Everything lives under `lib/` (the converter core);
 * this top-level barrel simply re-exports that surface so the package entry is
 * the converter surface.
 */
// DEFAULT (Node) entry: install the jsdom-backed HTML parser as a side effect
// BEFORE re-exporting the converter surface. The browser entry (`./browser.js`)
// installs the native-`DOMParser` parser instead and never loads this module, so
// jsdom stays out of client bundles.
import "./lib/dom-parser.node.js";

export * from "./lib/index.js";
