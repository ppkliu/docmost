import { ForbiddenException } from '@nestjs/common';
import { PresenceController } from './presence.controller';

// The gateways pull in ESM-only websocket dependencies that jest's CommonJS
// runtime cannot load; the controller only needs the two methods faked below.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));
jest.mock('../../ws/ws.gateway', () => ({ WsGateway: class {} }));

const workspace = { id: 'ws-1' } as any;
const admin = { id: 'admin' } as any;

function createController({
  canManage = true,
  rooms = new Map<string, Set<string>>(),
  sockets = new Map<string, any>(),
  documents = [] as any[],
  server = undefined as any,
} = {}) {
  const getPresence = jest.fn().mockReturnValue({ documents });
  const controller = new PresenceController(
    { getPresence } as any,
    {
      server:
        server === undefined ? { sockets: { adapter: { rooms }, sockets } } : server,
    } as any,
    { createForUser: () => ({ cannot: () => !canManage }) } as any,
  );
  return { controller, getPresence };
}

describe('PresenceController', () => {
  it('rejects users who cannot manage workspace settings', async () => {
    const { controller, getPresence } = createController({ canManage: false });
    await expect(controller.online(admin, workspace)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(getPresence).not.toHaveBeenCalled();
  });

  it('counts tabs per user from the workspace room only', async () => {
    const { controller, getPresence } = createController({
      rooms: new Map([
        ['workspace-ws-1', new Set(['s1', 's2', 's3', 's4'])],
        ['workspace-other', new Set(['s9'])],
      ]),
      sockets: new Map([
        ['s1', { data: { userId: 'u1' } }],
        ['s2', { data: { userId: 'u1' } }],
        ['s3', { data: { userId: 'u2' } }],
        ['s4', { data: {} }], // connected but not authenticated yet
        ['s9', { data: { userId: 'u9' } }],
      ]),
      documents: [
        { name: 'page.p1', connections: 2, userIds: ['u1', 'u2'], unsaved: true },
        { name: 'page.p2', connections: 1, userIds: ['u1'], unsaved: false },
      ],
    });

    const result = await controller.online(admin, workspace);

    expect(getPresence).toHaveBeenCalledWith('ws-1');
    expect(result.users).toEqual([
      { userId: 'u1', tabs: 2 },
      { userId: 'u2', tabs: 1 },
    ]);
    expect(result.tabCount).toBe(4);
    expect(result.documents).toEqual([
      { pageId: 'p1', connections: 2, userIds: ['u1', 'u2'], unsaved: true },
      { pageId: 'p2', connections: 1, userIds: ['u1'], unsaved: false },
    ]);
    expect(result.unsavedCount).toBe(1);
  });

  it('reports nobody online when the socket server is not up yet', async () => {
    const { controller } = createController({ server: null });
    const result = await controller.online(admin, workspace);
    expect(result.users).toEqual([]);
    expect(result.tabCount).toBe(0);
  });
});
