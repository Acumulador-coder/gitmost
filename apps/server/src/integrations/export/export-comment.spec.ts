import { JSDOM } from 'jsdom';
import { jsonToHtml } from '../../collaboration/collaboration.util';

/**
 * Page/space export (Markdown/HTML) of pages that contain inline comments.
 *
 * The in-process MCP module injects a jsdom `global.window` + `global.document`
 * into the Node server (see packages/mcp/src/lib/collaboration.ts). Without the
 * `isNodeRuntime` check, the comment mark's `renderHTML` would take the
 * interactive browser branch and return a LIVE jsdom <span> node, which
 * happy-dom's DOMSerializer (the export path) cannot append ("Cannot read
 * properties of undefined (reading 'length')").
 *
 * We reproduce the MCP-loaded server by injecting jsdom globals, then export a
 * doc containing a comment mark and assert the serialization SUCCEEDS and emits
 * the expected serializable <span data-comment-id=... class="comment-mark">.
 *
 * BOTH jsdom `window` AND `document` are set below: in a plain node env the
 * guard's `typeof window === "undefined"` clause already short-circuits, so it
 * is the injected globals that exercise the `isNodeRuntime` condition in
 * packages/editor-ext/src/lib/comment/comment.ts.
 */
describe('export with inline comments (issue #298)', () => {
  const originalWindow = (global as any).window;
  const originalDocument = (global as any).document;

  beforeAll(() => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    (global as any).window = dom.window;
    (global as any).document = dom.window.document;
  });

  afterAll(() => {
    (global as any).window = originalWindow;
    (global as any).document = originalDocument;
  });

  const docWithComment = (resolved: boolean) => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            marks: [
              {
                type: 'comment',
                attrs: { commentId: 'c-123', resolved },
              },
            ],
            text: 'commented text',
          },
        ],
      },
    ],
  });

  it('exports a page with an unresolved comment mark without crashing', () => {
    let html: string;
    expect(() => {
      html = jsonToHtml(docWithComment(false));
    }).not.toThrow();

    expect(html).toContain('data-comment-id="c-123"');
    expect(html).toContain('class="comment-mark"');
    expect(html).toContain('commented text');
  });

  it('exports a resolved comment mark with the resolved class/attr', () => {
    const html = jsonToHtml(docWithComment(true));
    expect(html).toContain('data-comment-id="c-123"');
    expect(html).toContain('comment-mark resolved');
    expect(html).toContain('data-resolved="true"');
  });
});
