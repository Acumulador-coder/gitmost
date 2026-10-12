/**
 * `flushPendingStore` reaches into Hocuspocus's PRIVATE debounce id of a
 * document's pending store (`storeDebounceId`). Against a REAL Hocuspocus
 * instance: an edit schedules the debounced store under exactly that id, and
 * the flush runs it now. If the library renames the id, this spec fails.
 */
import { Hocuspocus } from '@hocuspocus/server';
import { flushPendingStore, storeDebounceId } from './collaboration.util';

const DOC = 'page.5b0c4e0a-3f7d-4c1e-9a2b-6d8e1f0a2c3b';

describe('flushPendingStore against a real Hocuspocus', () => {
  it('flushes the debounced store an edit scheduled, under storeDebounceId', async () => {
    const onStoreDocument = jest.fn(async () => undefined);
    const hocuspocus = new Hocuspocus({
      debounce: 60_000,
      maxDebounce: 120_000,
      extensions: [{ onStoreDocument }],
    });
    const connection = await hocuspocus.openDirectConnection(DOC, {});
    const document = connection.document!;

    // An edit arriving from a client connection (any non-redis origin):
    // hocuspocus debounces its store.
    const origin = { context: {}, socketId: 'client', request: undefined };
    document.transact(() => document.getText('t').insert(0, 'edit'), origin);

    expect(hocuspocus.debouncer.isDebounced(storeDebounceId(DOC))).toBe(true);
    expect(onStoreDocument).not.toHaveBeenCalled();

    await expect(flushPendingStore(hocuspocus, DOC)).resolves.toBe(true);
    expect(onStoreDocument).toHaveBeenCalledTimes(1);
    expect(hocuspocus.debouncer.isDebounced(storeDebounceId(DOC))).toBe(false);
    // Nothing pending any more.
    await expect(flushPendingStore(hocuspocus, DOC)).resolves.toBe(false);
    expect(onStoreDocument).toHaveBeenCalledTimes(1);

    await connection.disconnect();
  });
});
