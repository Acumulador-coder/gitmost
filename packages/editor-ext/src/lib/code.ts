import { Code as TiptapCode } from "@tiptap/extension-code";

// Canonical inline `code` mark for Docmost. Tiptap's upstream Code mark ships
// `excludes: "_"`, which makes ProseMirror strip every co-occurring inline mark
// on the HTML -> PM parse (`generateJSON`) and on editor transactions, losing
// bold/italic around inline code on Markdown import (CommonMark keeps `**` around
// a `` `code` `` span as `<strong><code>…</code></strong>`). Override `excludes`
// so `code` combines with ALL other inline marks, matching CommonMark.
//
// The value is `"code"` (code excludes only itself, ProseMirror's default), not
// `""`: y-prosemirror keys a Yjs text attribute by the mark name only for marks
// that exclude themselves and uses a HASHED key (`code--<sha256 of the mark
// JSON>`) otherwise, which would store the same mark under a different Yjs key
// than every existing document. ProseMirror already de-dups identical marks, so
// self-exclusion costs nothing.
//
// This is the single source of the excludes policy: `documentExtensions` (the
// server schema and the markdown converter), the client `mainExtensions` and the
// comment editor all use this mark.
export const Code = TiptapCode.extend({ excludes: "code" });
