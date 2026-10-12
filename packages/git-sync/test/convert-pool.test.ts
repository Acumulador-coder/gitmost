import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  ConverterLossError,
  convertProseMirrorToMarkdown,
  markdownToProseMirror as convertInProcess,
} from '@docmost/prosemirror-markdown';
import {
  ConverterPool,
  MAX_DOC_JSON_BYTES,
  MAX_MARKDOWN_BYTES,
  converterPool,
  markdownToProseMirror,
} from '../src/engine/convert-pool';
import { stabilizePageBody } from '../src/engine/stabilize';

// git-sync's conversions run on worker threads (AGENTS invariant 3): the
// observable properties are the results (the same as the converter's), the
// input budget, the deadline, and an event loop that stays free meanwhile.

/** A markdown page of `n` paragraphs. */
function page(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `Paragraph ${i} with some **bold** text and a [link](https://example.com/${i}).`,
  ).join('\n\n');
}

describe('converter pool', () => {
  it('converts as the converter does, on a worker', async () => {
    const md =
      '# Title\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n' +
      '```ts\nconst x = 1;\n```\n\n> quote with $x^2$ math\n';

    expect(await markdownToProseMirror(md)).toEqual(await convertInProcess(md));
    expect(await markdownToProseMirror(md, { parseMath: false })).toEqual(
      await convertInProcess(md, { parseMath: false }),
    );

    const doc = await convertInProcess(md);
    const md1 = convertProseMirrorToMarkdown(doc, { strict: true });
    const expected = convertProseMirrorToMarkdown(await convertInProcess(md1), {
      strict: true,
    });
    expect(await stabilizePageBody(doc)).toBe(expected);
  });

  it('refuses input over its byte budget with the sizes, before any work', async () => {
    const pool = new ConverterPool({
      size: 1,
      deadlineMs: 60_000,
      maxMarkdownBytes: 10,
      maxDocJsonBytes: 30,
    });

    // 11 bytes in UTF-8 (the budget counts bytes, not characters).
    await expect(pool.markdownToProseMirror('ééééé!')).rejects.toThrow(
      'markdown -> ProseMirror conversion refused: the markdown is 11 bytes, ' +
        'over the 10-byte budget',
    );
    await expect(
      pool.stabilizePageBody({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
      }),
    ).rejects.toThrow(/^ProseMirror -> markdown export refused: the document is \d+ bytes of JSON, over the 30-byte budget$/);
    // The default pool refuses a markdown text just over its budget.
    await expect(
      converterPool.markdownToProseMirror('x'.repeat(MAX_MARKDOWN_BYTES + 1)),
    ).rejects.toThrow(`over the ${MAX_MARKDOWN_BYTES}-byte budget`);
  });

  it('keeps the event loop free during a long conversion, terminates it at its deadline, then converts on a fresh worker', async () => {
    // The pool reads its deadline when a call is submitted. The short one is
    // only for the huge call, whose deadline is what is tested; the call after
    // it gets one that covers a fresh worker's cold start (loading jsdom and
    // the converter takes seconds on a loaded CI runner), so the test does not
    // depend on how fast a worker starts.
    const options = {
      size: 1,
      deadlineMs: 2_000,
      maxMarkdownBytes: MAX_MARKDOWN_BYTES,
      maxDocJsonBytes: MAX_DOC_JSON_BYTES,
    };
    const pool = new ConverterPool(options);
    // Far more than 2 s of conversion on any machine (a 9,000-block page takes
    // about 7 s on a fast one).
    const huge = page(20_000);

    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    // The histogram records from its second tick on: let it tick first.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(pool.markdownToProseMirror(huge)).rejects.toThrow(
      /^markdown -> ProseMirror conversion of \d+ bytes exceeded its 2000 ms deadline; its worker thread was terminated$/,
    );
    delay.disable();
    // In process the same conversion blocks the loop for its whole duration.
    expect(delay.max / 1e6).toBeLessThan(250);

    // The terminated worker is replaced: the next call converts on a new one.
    options.deadlineMs = 120_000;
    expect(await pool.markdownToProseMirror('after')).toEqual(
      await convertInProcess('after'),
    );
  });

  it('an abort drops a queued call and terminates a running one, then the pool converts on a fresh worker', async () => {
    const pool = new ConverterPool({
      size: 1,
      deadlineMs: 120_000,
      maxMarkdownBytes: MAX_MARKDOWN_BYTES,
      maxDocJsonBytes: MAX_DOC_JSON_BYTES,
    });
    const controller = new AbortController();
    // Far more conversion than the test waits for: only the abort can end it.
    const running = pool.markdownToProseMirror(page(20_000), undefined, controller.signal);
    const queued = pool.markdownToProseMirror('queued', undefined, controller.signal);
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 200));

    controller.abort(new Error('the space lock was lost'));

    await expect(running).rejects.toMatchObject({
      name: 'CycleAbortedError',
      message: expect.stringMatching(
        /^git-sync stopped the markdown -> ProseMirror conversion of \d+ bytes: the space lock was lost$/,
      ),
    });
    await expect(queued).rejects.toMatchObject({ name: 'CycleAbortedError' });
    expect(Date.now() - started).toBeLessThan(5_000);
    // An already-aborted signal refuses the call before any work.
    await expect(
      pool.markdownToProseMirror('late', undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'CycleAbortedError' });
    expect(await pool.markdownToProseMirror('after')).toEqual(
      await convertInProcess('after'),
    );
  });

  it("rejects with the converter's own error, the pool keeps working", async () => {
    const pool = new ConverterPool({
      size: 1,
      deadlineMs: 60_000,
      maxMarkdownBytes: MAX_MARKDOWN_BYTES,
      maxDocJsonBytes: MAX_DOC_JSON_BYTES,
    });

    await expect(
      pool.stabilizePageBody({ type: 'doc', content: [{ type: 'noSuchNode' }] }),
    ).rejects.toBeInstanceOf(ConverterLossError);
    expect(await pool.markdownToProseMirror('ok')).toEqual(await convertInProcess('ok'));
  });
});
