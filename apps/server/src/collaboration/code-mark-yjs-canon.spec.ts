import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { Code } from '@docmost/editor-ext';

import { tiptapExtensions } from './collaboration.util';

/**
 * The Yjs KEY canon of the inline `code` mark, on the SERVER schema that reads
 * and writes Y.Docs (`tiptapExtensions`, used by persistence.extension.ts via
 * TiptapTransformer.toYdoc / .fromYdoc).
 *
 * y-prosemirror derives the Yjs text-attribute key from the mark's
 * self-exclusion (`marksToAttributes`, y-prosemirror 1.3.7):
 *
 *   const isOverlapping = !mark.type.excludes(mark.type);
 *   pattrs[isOverlapping ? `${name}--${hashOfJSON(mark.toJSON())}` : name] = mark.attrs;
 *
 * A mark that does not exclude itself is keyed by a hash.
 * `excludes: ""` would key inline code as `code--<hash>`; `excludes: "code"`
 * (exclude only itself) lets code coexist with bold / italic / … on the stock
 * `code` key.
 *
 * The markdown converter builds its schema from the same `documentExtensions`;
 * this spec pins what only the server can see: the assembled `tiptapExtensions`
 * schema, and the read-back of documents persisted with the hashed key.
 */

const CODE_TEXT = 'inline code';

const docWithInlineCode = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', marks: [{ type: 'code' }], text: CODE_TEXT }],
    },
  ],
};

/**
 * The Yjs text-attribute keys as they are ACTUALLY persisted: the `default`
 * fragment's first paragraph, its first XmlText run, read through `toDelta()`
 * (the same shape the collab handler's mark helpers walk).
 */
function persistedMarkKeys(ydoc: Y.Doc): string[] {
  const fragment = ydoc.getXmlFragment('default');
  const paragraph = fragment.get(0) as Y.XmlElement;
  const text = paragraph.get(0) as unknown as Y.XmlText;
  const keys = new Set<string>();
  for (const op of text.toDelta()) {
    for (const key of Object.keys(op.attributes ?? {})) {
      keys.add(key);
    }
  }
  return [...keys];
}

describe('#515 server `code` mark: Yjs key canon (tiptapExtensions)', () => {
  const schema = getSchema(tiptapExtensions as any);
  const code = schema.marks.code;

  it('excludes ITSELF, so y-prosemirror keys it plainly (`code`, not `code--<hash>`)', () => {
    expect(code.excludes(code)).toBe(true);
  });

  it('excludes NO other mark (#515: inline code carries bold / italic / …)', () => {
    const evicted = Object.values(schema.marks)
      .filter((markType: any) => markType.name !== 'code')
      .filter((markType: any) => code.excludes(markType))
      .map((markType: any) => markType.name);
    expect(evicted).toEqual([]);
  });

  it('every mark excludes itself, so no mark gets a hashed Yjs key (comment helpers read raw attribute names)', () => {
    const overlapping = Object.values(schema.marks)
      .filter((markType: any) => !markType.excludes(markType))
      .map((markType: any) => markType.name);
    expect(overlapping).toEqual([]);
  });

  it('no other mark excludes code (directionality, #515)', () => {
    const offenders = Object.values(schema.marks)
      .filter((markType: any) => markType.name !== 'code')
      .filter((markType: any) => markType.excludes(code))
      .map((markType: any) => markType.name);
    expect(offenders).toEqual([]);
  });

  it('WRITE path (TiptapTransformer.toYdoc) persists inline code under the plain `code` key', () => {
    // The end-to-end statement of the invariant: not "the schema says X" but "the
    // bytes we hand to Yjs are keyed `code`".
    const ydoc = TiptapTransformer.toYdoc(
      docWithInlineCode,
      'default',
      tiptapExtensions as any,
    );
    expect(persistedMarkKeys(ydoc)).toEqual(['code']);
  });
});

describe('#515 back-compat: documents persisted with the hashed `code--<hash>` key', () => {
  // The `code` mark with `excludes: ""`, so the hashed key is REPRODUCED rather
  // than hardcoded. A minimal schema suffices: the hash input is `mark.toJSON()`
  // (`{type:'code'}`, no attrs), independent of the other extensions.
  const legacyExtensions = [
    StarterKit.configure({
      codeBlock: false,
      link: false,
      trailingNode: false,
      heading: false,
      code: false,
    }),
    Code.extend({ excludes: '' }),
  ];

  const legacyYdoc = () =>
    TiptapTransformer.toYdoc(
      docWithInlineCode,
      'default',
      legacyExtensions as any,
    );

  it('the `excludes: ""` schema really did persist a HASHED key (the regression, reproduced)', () => {
    const keys = persistedMarkKeys(legacyYdoc());
    expect(keys).toHaveLength(1);
    // y-prosemirror's `hashedMarkNameRegex`: /(.*)(--[a-zA-Z0-9+/=]{8})$/
    expect(keys[0]).toMatch(/^code--[A-Za-z0-9+/=]{8}$/);
    expect(keys[0]).not.toBe('code');
  });

  it('the READ path (TiptapTransformer.fromYdoc) still maps it back to a plain `code` mark', () => {
    // Pages edited during the `excludes: ""` window carry the hashed key on disk
    // FOREVER — no migration rewrites them. They keep rendering only because
    // y-prosemirror strips the suffix on the way out (`yattr2markname`). This is the
    // assertion that keeps that true: it is the exact call persistence.extension.ts
    // makes when it turns a loaded Y.Doc back into page content.
    const json: any = TiptapTransformer.fromYdoc(legacyYdoc(), 'default');

    const textNode = json.content[0].content[0];
    expect(textNode.text).toBe(CODE_TEXT);
    expect(textNode.marks.map((mark: any) => mark.type)).toEqual(['code']);
  });
});
