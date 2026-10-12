import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';

import { tiptapExtensions } from '../collaboration.util';
import {
  mergeXmlFragments,
  mergeXmlFragments3WayWithStats,
} from './yjs-body-merge';

/**
 * Regression for the BUG CLASS behind the runaway whole-body duplication: a
 * block must key the same whether an attribute carries its editor-ext schema
 * default (the live Yjs doc materializes `indent: 0`, `image.align: "center"`,
 * link `internal: false`) or nothing at all (a raw Y fragment, or a body from
 * git where the converter defaults pdf/youtube sizes to null and
 * `y-prosemirror` drops null attrs). Element attrs and MARK attrs are both
 * covered — marks are serialized raw in the XmlText delta.
 *
 * `highlight.colorName` defaults to null, so it is normalized for free; the
 * schema-derived normalization stays idempotent.
 *
 * The block comparison key is the block's markdown projection (`blockKey`),
 * which no materialized default reaches — so a live block compares equal to
 * its git-round-tripped twin and an unchanged resync applies 0 ops. RED while
 * the key carried raw attributes (keys diverge -> ops > 0 / growth), GREEN
 * after.
 */

type Attrs = Record<string, unknown>;

function el(
  name: string,
  attrs: Attrs,
  children: (Y.XmlElement | Y.XmlText)[],
): Y.XmlElement {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  if (children.length) e.insert(0, children);
  return e;
}

/** Text carrying marks, as the live Yjs doc stores them (XmlText format ops). */
function markedText(s: string, marks: Record<string, unknown>): Y.XmlText {
  const t = new Y.XmlText();
  t.insert(0, s, marks);
  return t;
}

/**
 * One byte-identical RICH unit: a paragraph with a LINK, a top-level IMAGE, and
 * a paragraph with a HIGHLIGHT. `live` toggles exactly what the editor
 * materializes but a git round-trip does not: block `id`, `indent: 0`,
 * `image.align: "center"`, the link mark's `internal: false`, and the
 * highlight's `colorName: null`.
 */
function richUnit(live: boolean, n: number): Y.XmlElement[] {
  const ind: Attrs = live ? { indent: 0 } : {};
  const id = (base: string): Attrs => (live ? { id: `${base}${n}` } : {});

  const linkMarks = live
    ? {
        link: {
          href: 'https://example.com',
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
          class: null,
          title: null,
          internal: false, // editor-ext default, materialized
        },
      }
    : {
        link: {
          href: 'https://example.com',
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
          internal: null, // engine default
        },
      };

  const hlMarks = live
    ? { highlight: { color: '#ffd43b', colorName: null } }
    : { highlight: { color: '#ffd43b' } };

  const imageAttrs: Attrs = live
    ? { src: 'https://img.example.com/a.png', align: 'center' } // materialized
    : { src: 'https://img.example.com/a.png' }; // align:null dropped on git side

  return [
    el('paragraph', { ...id('lp'), ...ind }, [
      markedText('click here', linkMarks),
    ]),
    el('image', imageAttrs, []),
    el('paragraph', { ...id('hp'), ...ind }, [markedText('hot', hlMarks)]),
  ];
}

function fragmentOf(units: Y.XmlElement[][]): {
  doc: Y.Doc;
  frag: Y.XmlFragment;
} {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment('default');
  const blocks = units.flat();
  if (blocks.length) frag.insert(0, blocks);
  return { doc, frag };
}

const blockCount = (frag: Y.XmlFragment): number => frag.toArray().length;

describe('git-sync reconcile is idempotent for schema-default attrs (image/link/highlight)', () => {
  const UNITS = 3;

  it('3-way: live carries image.align/link.internal/indent defaults, base stale-by-one -> 0 ops', () => {
    const { doc: liveDoc, frag: live } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => richUnit(true, i)),
    );
    const { frag: incoming } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => richUnit(false, i)),
    );
    const { frag: base } = fragmentOf(
      Array.from({ length: UNITS - 1 }, (_, i) => richUnit(false, i)),
    );

    const before = blockCount(live);
    let applied = -1;
    liveDoc.transact(() => {
      applied = mergeXmlFragments3WayWithStats(live, incoming, base).applied;
    });

    expect(applied).toBe(0);
    expect(blockCount(live)).toBe(before);
  });

  it('2-way: live carries the materialized defaults -> 0 ops, no growth', () => {
    const { doc: liveDoc, frag: live } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => richUnit(true, i)),
    );
    const { frag: incoming } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => richUnit(false, i)),
    );

    const before = blockCount(live);
    let applied = -1;
    liveDoc.transact(() => {
      applied = mergeXmlFragments(live, incoming);
    });

    expect(applied).toBe(0);
    expect(blockCount(live)).toBe(before);
  });

  it('is a fixpoint across repeated cycles (does not grow)', () => {
    const { doc: liveDoc, frag: live } = fragmentOf(
      Array.from({ length: UNITS }, (_, i) => richUnit(true, i)),
    );
    const incoming = () =>
      fragmentOf(Array.from({ length: UNITS }, (_, i) => richUnit(false, i)))
        .frag;
    const base = () =>
      fragmentOf(
        Array.from({ length: UNITS - 1 }, (_, i) => richUnit(false, i)),
      ).frag;

    const before = blockCount(live);
    for (let cycle = 0; cycle < 5; cycle++) {
      let applied = -1;
      liveDoc.transact(() => {
        applied = mergeXmlFragments3WayWithStats(
          live,
          incoming(),
          base(),
        ).applied;
      });
      expect(applied).toBe(0);
      expect(blockCount(live)).toBe(before);
    }
  });

  it('does NOT regress a genuine non-default value (a real link.href / image.align:left still diffs)', () => {
    const { doc: liveDoc, frag: live } = fragmentOf([richUnit(true, 0)]);
    const base = fragmentOf([richUnit(false, 0)]).frag;
    // git genuinely changes the image alignment to a NON-default value.
    const incomingUnit = richUnit(false, 0);
    (incomingUnit[1] as Y.XmlElement).setAttribute('align', 'left');
    const incoming = fragmentOf([incomingUnit]).frag;

    liveDoc.transact(() => {
      mergeXmlFragments3WayWithStats(live, incoming, base);
    });

    const img = live
      .toArray()
      .find((b) => (b as Y.XmlElement).nodeName === 'image') as Y.XmlElement;
    expect(img.getAttribute('align')).toBe('left');
  });
});

/**
 * FAITHFUL end-to-end proof through the REAL server transformer: build the live
 * doc the way the collaboration server does (defaults omitted in the JSON ->
 * TiptapTransformer.toYdoc MATERIALIZES image.align:"center", link.internal:false,
 * indent:0) versus the git-derived doc (engine-style: defaults emitted as
 * explicit null, no block ids). An unchanged resync must apply 0 ops.
 */
describe('git-sync reconcile is idempotent through the real toYdoc materialization', () => {
  const liveContent = [
    {
      type: 'paragraph',
      attrs: { id: 'p1' },
      content: [
        {
          type: 'text',
          text: 'click here',
          marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
        },
      ],
    },
    { type: 'image', attrs: { src: 'https://img.example.com/a.png' } },
    {
      type: 'paragraph',
      attrs: { id: 'p2' },
      content: [
        {
          type: 'text',
          text: 'hot',
          marks: [{ type: 'highlight', attrs: { color: '#ffd43b' } }],
        },
      ],
    },
  ];

  // git/engine-style: explicit nulls for the engine-default attrs, no ids.
  const gitContent = [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'click here',
          marks: [
            {
              type: 'link',
              attrs: {
                href: 'https://example.com',
                target: '_blank',
                rel: 'noopener noreferrer nofollow',
                class: null,
                title: null,
                internal: null,
              },
            },
          ],
        },
      ],
    },
    {
      type: 'image',
      attrs: { src: 'https://img.example.com/a.png', align: null },
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'hot',
          marks: [
            { type: 'highlight', attrs: { color: '#ffd43b', colorName: null } },
          ],
        },
      ],
    },
  ];

  const toYdoc = (content: unknown[]) =>
    TiptapTransformer.toYdoc(
      { type: 'doc', content },
      'default',
      tiptapExtensions as any,
    );

  it('3-way: materialized-default live vs engine-style git, base stale-by-one -> 0 ops', () => {
    const liveDoc = toYdoc(liveContent);
    const targetDoc = toYdoc(gitContent);
    const baseDoc = toYdoc(gitContent.slice(0, gitContent.length - 1));

    const live = liveDoc.getXmlFragment('default');
    const before = live.toArray().length;
    let applied = -1;
    liveDoc.transact(() => {
      applied = mergeXmlFragments3WayWithStats(
        live,
        targetDoc.getXmlFragment('default'),
        baseDoc.getXmlFragment('default'),
      ).applied;
    });

    expect(applied).toBe(0);
    expect(live.toArray().length).toBe(before);
  });

  it('2-way: materialized-default live vs engine-style git -> 0 ops', () => {
    const liveDoc = toYdoc(liveContent);
    const targetDoc = toYdoc(gitContent);

    const live = liveDoc.getXmlFragment('default');
    const before = live.toArray().length;
    let applied = -1;
    liveDoc.transact(() => {
      applied = mergeXmlFragments(live, targetDoc.getXmlFragment('default'));
    });

    expect(applied).toBe(0);
    expect(live.toArray().length).toBe(before);
  });
});
