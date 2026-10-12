import { CollaborationGateway } from './collaboration.gateway';
import { CollaborationHandler } from './collaboration.handler';

/**
 * The COLLAB_DISABLE_REDIS fallback in handleYjsEvent: with Redis disabled there
 * is no RedisSyncExtension, so the handler must run locally against the single
 * hocuspocus instance and return its verdict (not silently no-op).
 *
 * The gateway is built with stub extensions and an EnvironmentService whose
 * isCollabDisableRedis() returns true (redisSync stays null, real hocuspocus is
 * still built); getHandlers is spied so no real direct connection is opened.
 */

const stubExtension = {} as any;

function makeEnv() {
  return {
    getRedisUrl: () => 'redis://localhost:6379',
    isCollabDisableRedis: () => true,
  } as any;
}

describe('CollaborationGateway.handleYjsEvent (no-Redis fallback)', () => {
  it('invokes the handler locally and returns its verdict instead of undefined', async () => {
    const collabHandler = new CollaborationHandler();
    const verdict = { applied: true, currentText: 'new' };
    const fakeHandler = jest.fn().mockResolvedValue(verdict);
    // Bypass the real direct-connection code path — assert dispatch only.
    jest
      .spyOn(collabHandler, 'getHandlers')
      .mockReturnValue({ applyCommentSuggestion: fakeHandler } as any);

    const gateway = new CollaborationGateway(
      stubExtension,
      stubExtension,
      stubExtension,
      makeEnv(),
      collabHandler,
    );

    const payload = {
      commentId: 'c1',
      expectedText: 'old',
      newText: 'new',
      user: { id: 'u1' } as any,
    };
    const result = await gateway.handleYjsEvent(
      'applyCommentSuggestion' as any,
      'doc-1',
      payload as any,
    );

    // No signal was passed: the handler gets `undefined` for it.
    expect(fakeHandler).toHaveBeenCalledWith('doc-1', payload, undefined);
    expect(result).toEqual(verdict);
    expect(result).not.toBeUndefined();
  });
});

/**
 * #647 refinement B — readLiveIfLoaded on the COLLAB_DISABLE_REDIS path. With no
 * RedisSyncExtension, the gateway must read via the local `readLiveContent`
 * handler (non-force-loading) and return its verdict, not silently no-op.
 */
describe('CollaborationGateway.readLiveIfLoaded (no-Redis path)', () => {
  it('delegates to the local readLiveContent handler and returns its result', async () => {
    const collabHandler = new CollaborationHandler();
    const loaded = { loaded: true, content: { type: 'doc' }, hash: 'h' };
    const readLiveContent = jest.fn().mockResolvedValue(loaded);
    jest
      .spyOn(collabHandler, 'getHandlers')
      .mockReturnValue({ readLiveContent } as any);

    const gateway = new CollaborationGateway(
      stubExtension,
      stubExtension,
      stubExtension,
      makeEnv(),
      collabHandler,
    );

    const res = await gateway.readLiveIfLoaded('page.uuid-1');
    expect(readLiveContent).toHaveBeenCalledWith('page.uuid-1');
    expect(res).toEqual(loaded);
  });
});
