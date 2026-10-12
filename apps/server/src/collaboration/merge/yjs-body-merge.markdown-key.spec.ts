import { TiptapTransformer } from '@hocuspocus/transformer';
import type { MarkType, Node as PMNode, NodeType } from '@tiptap/pm/model';
import * as Y from 'yjs';

import { getDocumentSchema, tiptapExtensions } from '../collaboration.util';
import {
  blockKey,
  mergeXmlFragments,
  mergeXmlFragments3WayWithStats,
} from './yjs-body-merge';

/**
 * The block key is the block's markdown projection, so a git body (rebuilt
 * from markdown) never sees the attributes markdown cannot express. These
 * specs pin what follows from that: such attributes never make a block differ
 * (parity, generated from the schema), a git edit of a block keeps them
 * (carry-over, nested table cells included), the git write touches only the
 * changed range of a block (GL-5), and an empty live paragraph at git's
 * insertion point is no conflict.
 */

const schema = getDocumentSchema();

/** A Y.Doc whose 'default' fragment holds `blocks` (ProseMirror JSON). */
function ydoc(blocks: any[]): Y.Doc {
  return TiptapTransformer.toYdoc(
    { type: 'doc', content: blocks },
    'default',
    tiptapExtensions,
  );
}

const frag = (doc: Y.Doc) => doc.getXmlFragment('default');
const json = (doc: Y.Doc) => TiptapTransformer.fromYdoc(doc, 'default');

const p = (text: string, attrs: Record<string, unknown> = {}) => ({
  type: 'paragraph',
  attrs,
  content: text ? [{ type: 'text', text }] : [],
});

// --- (d) parity, generated from the schema ----------------------------------

/** `node` wrapped in the ancestors a top-level block needs, as JSON. */
function asTopLevelBlock(node: PMNode): any | null {
  const wrapping = schema.topNodeType.contentMatch.findWrapping(node.type);
  if (!wrapping) return null;
  let out: PMNode | null = node;
  for (let i = wrapping.length - 1; i >= 0 && out; i--) {
    out = wrapping[i].createAndFill(null, out);
  }
  return out ? out.toJSON() : null;
}

/** Non-default values to try for an attribute with default `def`. */
function candidates(def: unknown): unknown[] {
  if (typeof def === 'number') return [def + 3];
  if (typeof def === 'boolean') return [!def];
  if (typeof def === 'string') return [def ? `${def}-parity` : 'parity'];
  if (Array.isArray(def)) return [[123]];
  return ['parity', 3, true, [123]];
}

/** The top-level block holding `type` with `attrs` (null if not buildable). */
function nodeBlock(type: NodeType, attrs: Record<string, unknown>) {
  try {
    const inner = type.isInline
      ? type.isText
        ? null
        : type.create(attrs)
      : type.createAndFill(attrs);
    return inner ? asTopLevelBlock(inner) : null;
  } catch {
    return null;
  }
}

function markBlock(type: MarkType, attrs: Record<string, unknown>) {
  try {
    return p('x').content.length
      ? {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x', marks: [type.create(attrs).toJSON()] },
          ],
        }
      : null;
  } catch {
    return null;
  }
}

type Case = { name: string; block: any; plain: any };

/**
 * Every node/mark attribute whose non-default value leaves the block's
 * markdown projection unchanged: the block with that value and the block
 * without it.
 */
function lossyAttrCases(): Case[] {
  const cases: Case[] = [];
  const build = (
    owner: string,
    specAttrs: Record<string, { default?: unknown }> | undefined,
    make: (attrs: Record<string, unknown>) => any,
  ) => {
    for (const [attr, spec] of Object.entries(specAttrs ?? {})) {
      if (attr === 'id') continue;
      const plain = make({});
      if (!plain) continue;
      let plainKey: string;
      try {
        plainKey = blockKey(frag(ydoc([plain])).get(0));
      } catch {
        continue;
      }
      for (const value of candidates(spec.default)) {
        const block = make({ [attr]: value });
        if (!block) continue;
        let key: string;
        try {
          key = blockKey(frag(ydoc([block])).get(0));
        } catch {
          continue;
        }
        if (key === plainKey) {
          cases.push({
            name: `${owner}.${attr}=${JSON.stringify(value)}`,
            block,
            plain,
          });
          break;
        }
      }
    }
  };
  for (const type of Object.values(schema.nodes)) {
    build(type.name, type.spec.attrs as any, (attrs) => nodeBlock(type, attrs));
  }
  for (const type of Object.values(schema.marks)) {
    build(`mark:${type.name}`, type.spec.attrs as any, (attrs) =>
      markBlock(type, attrs),
    );
  }
  return cases;
}

const CASES = lossyAttrCases();

describe('merge parity for attributes markdown cannot express (schema-generated)', () => {
  it('covers the known markdown losses (the generator is not vacuous)', () => {
    const names = CASES.map((c) => c.name.split('=')[0]);
    for (const known of [
      'paragraph.indent',
      'heading.indent',
      'callout.icon',
      'tableCell.colwidth',
      'tableCell.backgroundColor',
      'mark:link.internal',
    ]) {
      expect(names).toContain(known);
    }
  });

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s: an unchanged block merges with 0 ops, and keeps it across a git edit next to it',
    (_name, c) => {
      // 2-way unchanged resync: live carries the value, git cannot.
      const live2 = ydoc([c.block]);
      expect(mergeXmlFragments(frag(live2), frag(ydoc([c.plain])))).toBe(0);

      // 3-way: git edits only the neighbouring paragraph.
      const live = ydoc([c.block, p('neighbour')]);
      const block = frag(live).get(0);
      const before = JSON.stringify(json(live).content[0]);
      const { applied, conflicts } = mergeXmlFragments3WayWithStats(
        frag(live),
        frag(ydoc([c.plain, p('neighbour edited')])),
        frag(ydoc([c.plain, p('neighbour')])),
      );
      expect(conflicts).toBe(0);
      expect(applied).toBe(1);
      expect(frag(live).get(0)).toBe(block);
      expect(JSON.stringify(json(live).content[0])).toBe(before);
    },
  );
});

// --- (c) carry-over when git edits the block itself --------------------------

const cell = (text: string, attrs: Record<string, unknown> = {}) => ({
  type: 'tableCell',
  attrs,
  content: [p(text)],
});
const table = (rows: any[][]) => ({
  type: 'table',
  content: rows.map((cells) => ({ type: 'tableRow', content: cells })),
});

describe('git edit of a block keeps the attributes markdown loses (carry-over)', () => {
  it('a table cell edit keeps every cell colwidth/backgroundColor, in place', () => {
    const styled = { colwidth: [200], backgroundColor: '#ffeeaa' };
    const live = ydoc([
      table([
        [cell('a', styled), cell('b', { colwidth: [80] })],
        [cell('c'), cell('d', { backgroundColor: '#ccddff' })],
      ]),
    ]);
    const tableEl = frag(live).get(0);
    const base = ydoc([
      table([
        [cell('a'), cell('b')],
        [cell('c'), cell('d')],
      ]),
    ]);
    const target = ydoc([
      table([
        [cell('a'), cell('b')],
        [cell('c'), cell('d edited')],
      ]),
    ]);

    const { applied, conflicts } = mergeXmlFragments3WayWithStats(
      frag(live),
      frag(target),
      frag(base),
    );

    expect(conflicts).toBe(0);
    expect(applied).toBe(1);
    expect(frag(live).get(0)).toBe(tableEl);
    const rows = json(live).content[0].content;
    const attrsOf = (r: number, c: number) => rows[r].content[c].attrs;
    expect(attrsOf(0, 0)).toMatchObject(styled);
    expect(attrsOf(0, 1)).toMatchObject({ colwidth: [80] });
    expect(attrsOf(1, 1)).toMatchObject({ backgroundColor: '#ccddff' });
    expect(rows[1].content[1].content[0].content[0].text).toBe('d edited');
  });

  it('a git edit in a run of indented paragraphs keeps every indent', () => {
    const live = ydoc([p('one', { indent: 2 }), p('two', { indent: 1 })]);
    const { conflicts } = mergeXmlFragments3WayWithStats(
      frag(live),
      frag(ydoc([p('one'), p('two edited')])),
      frag(ydoc([p('one'), p('two')])),
    );
    expect(conflicts).toBe(0);
    const blocks = json(live).content;
    expect(blocks.map((b: any) => b.attrs.indent)).toEqual([2, 1]);
    expect(blocks[1].content[0].text).toBe('two edited');
  });

  it('an in-place update keeps the live block and its id, and takes what git changed', () => {
    const live = ydoc([
      {
        type: 'heading',
        attrs: { level: 2, id: 'live-h' },
        content: [{ type: 'text', text: 'Title' }],
      },
    ]);
    const heading = frag(live).get(0);
    const h = (level: number, text: string) => ({
      type: 'heading',
      attrs: { level, id: `git-${level}` },
      content: [{ type: 'text', text }],
    });
    mergeXmlFragments3WayWithStats(
      frag(live),
      frag(ydoc([h(3, 'New title')])),
      frag(ydoc([h(2, 'Title')])),
    );
    expect(frag(live).get(0)).toBe(heading);
    expect(json(live).content[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 3, id: 'live-h' },
      content: [{ type: 'text', text: 'New title' }],
    });
  });
});

// --- GL-5: a client edit made offline survives a git edit of the same block --

describe('GL-5: the git write touches only the changed range of a block', () => {
  it('an offline client edit to the block git changes survives once it syncs', () => {
    const server = ydoc([p('alpha'), p('the quick brown fox')]);
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));

    // Offline: the client appends to block 1; nothing reaches the server yet.
    const clientText = (frag(client).get(1) as Y.XmlElement).get(
      0,
    ) as Y.XmlText;
    clientText.insert(clientText.length, ' jumps');
    const offline = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));

    // Meanwhile git changes one word of the same block.
    const { conflicts } = mergeXmlFragments3WayWithStats(
      frag(server),
      frag(ydoc([p('alpha'), p('the quick red fox')])),
      frag(ydoc([p('alpha'), p('the quick brown fox')])),
    );
    expect(conflicts).toBe(0);

    // The client reconnects: its edit lands in the same, still-live text.
    Y.applyUpdate(server, offline);
    expect(json(server).content[1].content[0].text).toBe(
      'the quick red fox jumps',
    );
  });
});

// --- item 13: an empty live paragraph where git inserts ----------------------

describe('an empty live paragraph at git insertion point', () => {
  it('is no conflict; both stay, the live paragraph first', () => {
    const live = ydoc([p('A'), p(''), p('B')]);
    const { conflicts } = mergeXmlFragments3WayWithStats(
      frag(live),
      frag(ydoc([p('A'), p('G'), p('B')])),
      frag(ydoc([p('A'), p('B')])),
    );
    expect(conflicts).toBe(0);
    expect(
      json(live).content.map((b: any) => b.content?.[0]?.text ?? ''),
    ).toEqual(['A', '', 'G', 'B']);
  });
});
