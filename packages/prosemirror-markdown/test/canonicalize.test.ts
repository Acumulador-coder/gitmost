import { describe, expect, it } from 'vitest';
// Import via the package barrel to also assert the symbols are re-exported.
import {
  canonicalizeContent,
  docsCanonicallyEqual,
  docsEqualUpToMarkdown,
  isIgnorableBlockKey,
  markdownBlockKey,
} from 'docmost-client';

describe('canonicalizeContent', () => {
  it('strips node-level attrs.id, recursively', () => {
    const input = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { id: 'h-1', level: 2 },
          content: [{ type: 'text', text: 'Title' }],
        },
      ],
    };
    const out = canonicalizeContent(input);
    expect(out.content[0].attrs).toEqual({ level: 2 });
    // No `id` survives anywhere in the canonical tree.
    expect(JSON.stringify(out)).not.toContain('"id"');
  });

  it('drops null/undefined attrs but keeps every non-null attr', () => {
    const out = canonicalizeContent({
      type: 'paragraph',
      attrs: {
        id: 'p-1',
        indent: null,
        textAlign: undefined,
        level: 0,
        keep: 'yes',
      },
      content: [],
    });
    // null/undefined gone; non-null values (incl. 0 and false) kept.
    expect(out.attrs).toEqual({ keep: 'yes', level: 0 });
  });

  it('removes an attrs object that becomes empty after pruning', () => {
    const out = canonicalizeContent({
      type: 'paragraph',
      attrs: { id: 'p-1', indent: null, textAlign: null },
      content: [{ type: 'text', text: 'x' }],
    });
    // attrs had only an id + null defaults -> the whole attrs key is dropped.
    expect('attrs' in out).toBe(false);
    expect(out).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'x' }],
    });
  });

  it('treats {attrs:{}} as equivalent to no attrs', () => {
    const withEmpty = canonicalizeContent({ type: 'paragraph', attrs: {} });
    const without = canonicalizeContent({ type: 'paragraph' });
    expect(withEmpty).toEqual(without);
  });

  it('keeps comment marks + commentId but normalizes resolved:false default (SPEC §3 anchor)', () => {
    const out = canonicalizeContent({
      type: 'text',
      text: 'anchored',
      marks: [
        { type: 'comment', attrs: { commentId: 'cmt-1', resolved: false } },
      ],
    });
    // The comment mark is preserved; commentId (a meaningful anchor) survives,
    // but the `resolved: false` schema default is normalized away.
    expect(out.marks).toEqual([
      { type: 'comment', attrs: { commentId: 'cmt-1' } },
    ]);
  });

  it('drops known non-null schema defaults (link target/rel, comment resolved)', () => {
    const out = canonicalizeContent({
      type: 'text',
      text: 'a link',
      marks: [
        {
          type: 'link',
          attrs: {
            href: 'https://example.com/page',
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
          },
        },
      ],
    });
    // href (non-default) kept; target/rel (schema defaults) dropped.
    expect(out.marks).toEqual([
      { type: 'link', attrs: { href: 'https://example.com/page' } },
    ]);
  });

  it('keeps a NON-default value that happens to share an attr name (orderedList start:5)', () => {
    const out = canonicalizeContent({
      type: 'orderedList',
      attrs: { id: 'ol-1', start: 5 },
      content: [],
    });
    // start:5 is NOT the default (1), so it must survive.
    expect(out.attrs).toEqual({ start: 5 });
  });

  it('keeps meaningful node/mark attrs (level, language, href, src, width)', () => {
    const out = canonicalizeContent({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { id: 'c-1', language: 'js' },
          content: [{ type: 'text', text: 'x' }],
        },
        {
          type: 'image',
          attrs: { id: 'i-1', src: '/a.png', width: 100, height: null },
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'link',
              marks: [{ type: 'link', attrs: { href: 'https://e.com' } }],
            },
          ],
        },
      ],
    });
    expect(out.content[0].attrs).toEqual({ language: 'js' });
    expect(out.content[1].attrs).toEqual({ src: '/a.png', width: 100 });
    expect(out.content[2].content[0].marks[0].attrs).toEqual({
      href: 'https://e.com',
    });
  });

  it('preserves text, type and content order exactly', () => {
    const input = {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'three' },
      ],
    };
    const out = canonicalizeContent(input);
    expect(out.content.map((n: any) => n.text)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(out.content[1].marks).toEqual([{ type: 'bold' }]);
  });

  it('drops an empty marks array (marks:[] === no marks)', () => {
    const out = canonicalizeContent({ type: 'text', text: 'x', marks: [] });
    expect('marks' in out).toBe(false);
  });

  it('does not mutate its input (frozen tree passes through unchanged)', () => {
    const input = Object.freeze({
      type: 'doc',
      content: Object.freeze([
        Object.freeze({
          type: 'paragraph',
          attrs: Object.freeze({ id: 'p-1', indent: null }),
          content: Object.freeze([Object.freeze({ type: 'text', text: 'x' })]),
        }),
      ]),
    });
    const before = JSON.stringify(input);
    const out = canonicalizeContent(input);
    // Input is structurally identical after the call.
    expect(JSON.stringify(input)).toBe(before);
    // A fresh tree is returned.
    expect(out).not.toBe(input);
    expect('attrs' in out.content[0]).toBe(false);
  });
});

describe('docsCanonicallyEqual', () => {
  it('is true when docs differ only by block ids', () => {
    const a = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'h-1', level: 1 }, content: [] },
      ],
    };
    const b = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'h-DIFFERENT', level: 1 }, content: [] },
      ],
    };
    expect(docsCanonicallyEqual(a, b)).toBe(true);
  });

  it('is true when one side omits an attr the other sets to default null', () => {
    const a = {
      type: 'paragraph',
      attrs: { id: 'p-1' },
      content: [{ type: 'text', text: 'x' }],
    };
    const b = {
      type: 'paragraph',
      attrs: { id: 'p-2', indent: null, textAlign: null },
      content: [{ type: 'text', text: 'x' }],
    };
    expect(docsCanonicallyEqual(a, b)).toBe(true);
  });

  it('is key-order-insensitive for attrs', () => {
    const a = { type: 'image', attrs: { src: '/a.png', width: 10 } };
    const b = { type: 'image', attrs: { width: 10, src: '/a.png' } };
    expect(docsCanonicallyEqual(a, b)).toBe(true);
  });

  it('is false for a real text difference', () => {
    const a = { type: 'text', text: 'hello' };
    const b = { type: 'text', text: 'world' };
    expect(docsCanonicallyEqual(a, b)).toBe(false);
  });

  it('is false for a real attr difference (different level)', () => {
    const a = { type: 'heading', attrs: { id: 'x', level: 1 } };
    const b = { type: 'heading', attrs: { id: 'y', level: 2 } };
    expect(docsCanonicallyEqual(a, b)).toBe(false);
  });

  it('is false when a meaningful mark attr differs (commentId)', () => {
    const a = {
      type: 'text',
      text: 'x',
      marks: [{ type: 'comment', attrs: { commentId: 'cmt-1' } }],
    };
    const b = {
      type: 'text',
      text: 'x',
      marks: [{ type: 'comment', attrs: { commentId: 'cmt-2' } }],
    };
    expect(docsCanonicallyEqual(a, b)).toBe(false);
  });

  it('is true when a link has only href vs one with the schema-default target/rel', () => {
    const a = {
      type: 'text',
      text: 'link',
      marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
    };
    const b = {
      type: 'text',
      text: 'link',
      marks: [
        {
          type: 'link',
          attrs: {
            href: 'https://example.com',
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
          },
        },
      ],
    };
    expect(docsCanonicallyEqual(a, b)).toBe(true);
  });

  it('is true when an orderedList omits start vs one with the default start:1', () => {
    const a = { type: 'orderedList', content: [] };
    const b = { type: 'orderedList', attrs: { start: 1 }, content: [] };
    expect(docsCanonicallyEqual(a, b)).toBe(true);
  });

  it('is false when an orderedList has a non-default start (5 vs absent)', () => {
    const a = { type: 'orderedList', content: [] };
    const b = { type: 'orderedList', attrs: { start: 5 }, content: [] };
    expect(docsCanonicallyEqual(a, b)).toBe(false);
  });

  it('is true when a comment mark omits resolved vs one with the default false', () => {
    const a = {
      type: 'text',
      text: 'x',
      marks: [{ type: 'comment', attrs: { commentId: 'cmt-1' } }],
    };
    const b = {
      type: 'text',
      text: 'x',
      marks: [{ type: 'comment', attrs: { commentId: 'cmt-1', resolved: false } }],
    };
    expect(docsCanonicallyEqual(a, b)).toBe(true);
  });

  it('is false when a comment mark is dropped entirely', () => {
    const a = {
      type: 'text',
      text: 'x',
      marks: [{ type: 'comment', attrs: { commentId: 'cmt-1' } }],
    };
    const b = { type: 'text', text: 'x' };
    expect(docsCanonicallyEqual(a, b)).toBe(false);
  });
});

// The defaults come from the converter schema, not from a hand-kept list.
describe('canonicalizeContent schema defaults', () => {
  const doc = (content: any[]) => ({ type: 'doc', content });

  it('drops a default the schema declares beyond the old hand list', () => {
    const cell = (attrs?: any) => ({
      type: 'tableCell',
      ...(attrs ? { attrs } : {}),
      content: [{ type: 'paragraph' }],
    });
    expect(
      docsCanonicallyEqual(
        doc([{ type: 'tableRow', content: [cell({ colspan: 1, rowspan: 1 })] }]),
        doc([{ type: 'tableRow', content: [cell()] }]),
      ),
    ).toBe(true);
    expect(
      docsCanonicallyEqual(
        doc([{ type: 'callout', attrs: { type: 'info' }, content: [] }]),
        doc([{ type: 'callout', content: [] }]),
      ),
    ).toBe(true);
  });

  it('keeps a non-default value of such an attr', () => {
    expect(
      docsCanonicallyEqual(
        doc([{ type: 'callout', attrs: { type: 'warning' }, content: [] }]),
        doc([{ type: 'callout', content: [] }]),
      ),
    ).toBe(false);
  });
});

describe('markdownBlockKey / docsEqualUpToMarkdown', () => {
  const p = (text: string, attrs?: any) => ({
    type: 'paragraph',
    ...(attrs ? { attrs } : {}),
    content: text ? [{ type: 'text', text }] : [],
  });
  const doc = (...content: any[]) => ({ type: 'doc', content });

  it('projects a block to its markdown; an empty paragraph is ignorable', () => {
    expect(markdownBlockKey(p('Hello'))).toContain('Hello');
    expect(isIgnorableBlockKey(markdownBlockKey(p('Hello')))).toBe(false);
    expect(isIgnorableBlockKey(markdownBlockKey(p('')))).toBe(true);
  });

  it('is true for docs differing only in what markdown cannot carry', () => {
    const table = (attrs: any) => ({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', attrs, content: [p('cell')] },
          ],
        },
      ],
    });
    expect(
      docsEqualUpToMarkdown(
        doc(
          p('one', { id: 'a', indent: 2 }),
          table({ colwidth: [200], backgroundColor: '#ff0' }),
          p(''),
        ),
        doc(p('one'), table({})),
      ),
    ).toBe(true);
  });

  it('is false for a text change or a block reorder', () => {
    expect(docsEqualUpToMarkdown(doc(p('one')), doc(p('two')))).toBe(false);
    expect(
      docsEqualUpToMarkdown(doc(p('a'), p('b')), doc(p('b'), p('a'))),
    ).toBe(false);
  });
});
