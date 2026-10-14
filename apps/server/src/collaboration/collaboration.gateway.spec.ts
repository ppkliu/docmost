import { CollaborationGateway } from './collaboration.gateway';

// Redis sync is disabled in these tests, and its ESM-only dependency (lib0)
// cannot be loaded by jest's CommonJS runtime.
jest.mock('./extensions/redis-sync', () => ({
  RedisSyncExtension: class {},
}));
jest.mock('./extensions/redis-sync/ws-socket-wrapper', () => ({
  WsSocketWrapper: class {},
}));

function createGateway(onStoreDocument: jest.Mock) {
  const environmentService = {
    getRedisUrl: () => 'redis://localhost:6379',
    isCollabDisableRedis: () => true,
  };
  return new CollaborationGateway(
    {} as any,
    { onStoreDocument } as any,
    {} as any,
    environmentService as any,
    {} as any,
  );
}

// Leaves the document in the state a restart must not lose: its last editor
// has gone, and the edit is still waiting on the 10s debounce timer.
async function leaveUnsavedDocument(gateway: CollaborationGateway, name: string) {
  const hocuspocus = (gateway as any).hocuspocus;
  const direct = await gateway.openDirectConnection(name, {});
  const document = direct.document;
  hocuspocus.storeDocumentHooks(document, {
    document,
    documentName: name,
    instance: hocuspocus,
    context: {},
    clientsCount: 0,
    requestHeaders: {},
    requestParameters: new URLSearchParams(),
    socketId: 'test',
  });
  document.removeDirectConnection();
}

describe('CollaborationGateway shutdown', () => {
  const collabWsAdapter = { close: jest.fn(), destroy: jest.fn() } as any;

  it('reports a document with a pending store as unsaved', async () => {
    const onStoreDocument = jest.fn().mockResolvedValue(undefined);
    const gateway = createGateway(onStoreDocument);
    await leaveUnsavedDocument(gateway, 'page.a');

    expect(gateway.getPresence().documents).toEqual([
      { name: 'page.a', connections: 0, userIds: [], unsaved: true },
    ]);

    await gateway.destroy(collabWsAdapter);
  });

  it('stores pending edits on destroy without waiting for the debounce timer', async () => {
    const onStoreDocument = jest.fn().mockResolvedValue(undefined);
    const gateway = createGateway(onStoreDocument);
    await leaveUnsavedDocument(gateway, 'page.a');
    await leaveUnsavedDocument(gateway, 'page.b');
    expect(onStoreDocument).not.toHaveBeenCalled();

    const startedAt = Date.now();
    await gateway.destroy(collabWsAdapter);

    expect(onStoreDocument).toHaveBeenCalledTimes(2);
    expect(gateway.getDocumentCount()).toBe(0);
    // the debounce is 10s; anything close to it means the flush did not happen
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('resolves immediately when nothing is loaded', async () => {
    const gateway = createGateway(jest.fn());
    await gateway.destroy(collabWsAdapter);
    expect(gateway.getDocumentCount()).toBe(0);
  });
});
