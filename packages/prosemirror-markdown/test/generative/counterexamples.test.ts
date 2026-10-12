import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { convertProseMirrorToMarkdown } from '../../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../../src/lib/markdown-to-prosemirror.js';
import { docsCanonicallyEqual } from '../../src/lib/canonicalize.js';
import { canonicalizeMarkdownWhitespace } from '../roundtrip-helpers.js';

// ---------------------------------------------------------------------------
// Committed counterexamples: minimal documents (test/fixtures/counterexamples/)
// for round-trip losses found by generative probing, kept as regression pins.
// The attributes involved are also value-fuzzed by the generator (see
// attr-arbitraries.ts).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, '../fixtures/counterexamples');

function loadDoc(file: string): any {
  return JSON.parse(readFileSync(path.join(fixtureDir, file), 'utf8')).doc;
}

describe('#351 counterexamples (round-trip bugs, now FIXED — permanent regression pins)', () => {
  // An `orderedList` with a non-1 `start` must keep its start number: the
  // markdown path emits `${start + index}.` and the raw-HTML path
  // `<ol start="N">` (src/lib/markdown-converter.ts); tiptap's StarterKit /
  // marked parse the start back.
  it('ordered list start number is preserved (P1)', async () => {
    const doc = loadDoc('ordered-list-start.json');
    const md1 = convertProseMirrorToMarkdown(doc);
    const doc2 = await markdownToProseMirror(md1);
    expect(docsCanonicallyEqual(doc2, doc)).toBe(true);
  });

  // A mark whose text carries LEADING/TRAILING whitespace: a closing delimiter
  // run preceded by whitespace is not right-flanking, so `**Модель: **WB-MGE`
  // never closes and the corruption is BYTE-STABLE (only P1 sees it).
  // `wrapFlankingDelimited` (src/lib/markdown-converter.ts) expels the edge
  // whitespace OUTSIDE the delimiters — `**Модель:** WB-MGE`.
  it('mark-edge whitespace keeps its mark through the round-trip (P1)', async () => {
    const doc = loadDoc('mark-edge-whitespace.json');
    const md1 = convertProseMirrorToMarkdown(doc);
    const doc2 = await markdownToProseMirror(md1);

    // The exact markdown the fix must emit: delimiters glued to the text, the
    // whitespace outside them. A single assertion on the bytes pins the shape
    // for `**`, `==`, `***` (bold+italic) and `~~` at once.
    expect(md1).toBe(
      '**Модель:** WB-MGE\n\na ==hl== b\n\nx ***both*** y\n\ns ~~out~~ e',
    );

    // Semantic round-trip: nothing but the whitespace POSITION relative to the
    // mark boundary may change (see canonicalizeMarkdownWhitespace) — every mark, and
    // every character, survives.
    expect(
      docsCanonicallyEqual(
        canonicalizeMarkdownWhitespace(doc2),
        canonicalizeMarkdownWhitespace(doc),
      ),
    ).toBe(true);

    // No literal delimiter leaked into the document text, and no character was
    // dropped: the paragraph text is byte-identical to the source.
    const textOf = (d: any): string =>
      (d.content ?? [])
        .map((p: any) => (p.content ?? []).map((n: any) => n.text ?? '').join(''))
        .join('\n');
    expect(textOf(doc2)).toBe(textOf(doc));

    // Byte fixpoint (P2) holds too.
    expect(convertProseMirrorToMarkdown(doc2)).toBe(md1);
  });
});
