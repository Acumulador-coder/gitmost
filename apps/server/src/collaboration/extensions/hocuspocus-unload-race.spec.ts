/**
 * Connect-vs-unload race in @hocuspocus/server 3.4.4 (patched via
 * patches/@hocuspocus__server@3.4.4.patch).
 *
 * Unpatched: when the last client disconnects, storeDocumentHooks' `finally`
 * schedules an async `unloadDocument`, which records an in-flight promise in
 * `this.unloadingDocuments` while its `beforeUnloadDocument` hooks run.
 * `createDocument` never consults `unloadingDocuments`, so a new connection in
 * that window can load (or reuse) the doc while it is being torn down; the
 * unload's re-check (`shouldUnloadDocument`, 0 connections because async auth
 * hasn't registered the new one) then destroys the doc under the new client,
 * and redis-sync never completes (the provider hangs until its ~25s timeout).
 *
 * The patch: `createDocument` first awaits any in-flight
 * `unloadingDocuments.get(name)`; afterwards the doc is either fully unloaded (a
 * clean fresh load) or the unload aborted (healthy doc reused).
 *
 * These tests exercise the real patched `Hocuspocus.createDocument` by seeding
 * `unloadingDocuments` with a controllable in-flight unload.
 */
import { Hocuspocus } from '@hocuspocus/server';

// A promise we can resolve on demand, to model an unload that is mid-flight.
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('gitmost #401 — hocuspocus createDocument awaits in-flight unload', () => {
  it('does NOT start loading a new doc until the in-flight unload settles, then loads fresh', async () => {
    const hp = new Hocuspocus();
    const name = 'page.race';

    // Observe loadDocument: on the unpatched code it is invoked synchronously
    // within createDocument (before the unload settles); on the patched code it
    // must be deferred until unloadingDocuments resolves.
    const freshDoc = { name, __fresh: true } as any;
    const loadSpy = jest
      .spyOn(hp as any, 'loadDocument')
      .mockResolvedValue(freshDoc);

    // Model an unload in progress: an entry sits in unloadingDocuments and, when
    // it completes, it removes the doc from `documents` (a real full unload).
    const unload = deferred();
    (hp as any).documents.set(name, { name, __dying: true });
    (hp as any).unloadingDocuments.set(
      name,
      unload.promise.then(() => {
        (hp as any).documents.delete(name);
      }),
    );

    // Kick off a new connection's createDocument but do not await it yet.
    const createPromise = (hp as any).createDocument(
      name,
      {},
      'socket-1',
      { isAuthenticated: true, readOnly: false },
      {},
    );

    // Let all currently-schedulable microtasks run. The patched createDocument is
    // now parked on `await unloadingDocuments.get(name)`, so loadDocument must
    // NOT have been called yet, and it must NOT have returned the dying doc.
    await Promise.resolve();
    await Promise.resolve();
    expect(loadSpy).not.toHaveBeenCalled();

    // The unload completes (doc removed from `documents`).
    unload.resolve();

    // createDocument now proceeds: sees no existing doc → fresh load.
    const doc = await createPromise;
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(doc).toBe(freshDoc);
    // The freshly-loaded doc is the one registered — never the dying instance.
    expect((hp as any).documents.get(name)).toBe(freshDoc);
  });

  it('reuses the live doc when the in-flight unload aborts (doc left in documents)', async () => {
    const hp = new Hocuspocus();
    const name = 'page.abort';

    const loadSpy = jest.spyOn(hp as any, 'loadDocument');

    // Model an unload that ABORTS (e.g. a new connection reappeared before the
    // sync re-check): it settles WITHOUT deleting the doc from `documents`.
    const unload = deferred();
    const liveDoc = { name, __live: true } as any;
    (hp as any).documents.set(name, liveDoc);
    (hp as any).unloadingDocuments.set(name, unload.promise); // no-op unload

    const createPromise = (hp as any).createDocument(
      name,
      {},
      'socket-2',
      { isAuthenticated: true, readOnly: false },
      {},
    );

    unload.resolve();
    const doc = await createPromise;

    // The still-present live doc is reused; no fresh load happened.
    expect(doc).toBe(liveDoc);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('no in-flight unload → behaves normally (fresh load)', async () => {
    const hp = new Hocuspocus();
    const name = 'page.normal';
    const freshDoc = { name } as any;
    const loadSpy = jest
      .spyOn(hp as any, 'loadDocument')
      .mockResolvedValue(freshDoc);

    const doc = await (hp as any).createDocument(
      name,
      {},
      'socket-3',
      { isAuthenticated: true, readOnly: false },
      {},
    );

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(doc).toBe(freshDoc);
  });
});
