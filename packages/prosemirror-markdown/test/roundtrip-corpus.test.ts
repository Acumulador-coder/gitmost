import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
  docsCanonicallyEqual,
} from 'docmost-client';

// Resolve fixtures relative to this test file so the test is CWD-independent.
const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, 'fixtures', 'corpus');

/** Run a single document through export -> import -> export. */
async function roundTrip(doc: any) {
  const md1 = convertProseMirrorToMarkdown(doc);
  const doc2 = await markdownToProseMirror(md1);
  const md2 = convertProseMirrorToMarkdown(doc2);
  return { md1, md2, doc2 };
}

describe('round-trip corpus (SPEC §11)', () => {
  // Discover the corpus synchronously at collection time so each fixture gets
  // its own `it` with the file name in the test title.
  const files = readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();

  it('has a non-empty corpus', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const name of files) {
    it(`${name}: markdown byte-stable AND canonically stable`, async () => {
      const doc = JSON.parse(await readFile(join(CORPUS_DIR, name), 'utf8'));
      const { md1, md2, doc2 } = await roundTrip(doc);

      // 1) The byte-stable markdown property git actually needs.
      expect(md2, `${name}: markdown not byte-stable`).toBe(md1);
      // 2) Semantic stability (block ids stripped, default-null normalized).
      expect(
        docsCanonicallyEqual(doc, doc2),
        `${name}: document not canonically stable`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Images and diagrams (SPEC §11 high round-trip risk) are covered by
// fixtures/corpus/11-image-diagrams.json in the corpus loop above: the diagram
// family serializes as `![](src)<!--drawio|excalidraw {…}-->` with a default
// `align:"center"` OMITTED, and `stripEmptyParagraphs` absorbs the block-image
// hoist, so the fixture is byte-stable AND canonically stable.
// ---------------------------------------------------------------------------
