import { KbSyncService } from './kb-sync.service';

const WS = 'ws-1';

function makeDb(opts: { settings?: unknown; pages?: any[]; spaces?: any[] }) {
  const chainResult = (table: string) => {
    if (table === 'workspaces') {
      return { rows: [{ settings: opts.settings ?? null }], single: true };
    }
    if (table === 'pages') return { rows: opts.pages ?? [], single: false };
    if (table === 'spaces') return { rows: opts.spaces ?? [], single: false };
    return { rows: [], single: false };
  };
  return {
    selectFrom: (table: string) => {
      const { rows } = chainResult(table);
      const chain: any = {
        select: () => chain,
        distinct: () => chain,
        where: () => chain,
        executeTakeFirst: async () => rows[0],
        execute: async () => rows,
      };
      return chain;
    },
  } as any;
}

const CONNECTOR = {
  id: 'kb1',
  type: 'cognee',
  name: 'Synced',
  baseUrl: 'http://kb',
  enabled: true,
  sync: true,
};

function makeService(opts: {
  settings?: unknown;
  pages?: any[];
  spaces?: any[];
  kbOverrides?: Record<string, any>;
} = {}) {
  const settings = opts.settings ?? { ai: { knowledgeBases: [CONNECTOR] } };
  const permRepo = {
    hasRestrictedAncestor: jest.fn().mockResolvedValue(false),
  };
  const kb = {
    getConnectors: jest.fn().mockReturnValue([CONNECTOR]),
    datasetName: (ws: string, s: string) =>
      `docmost_${ws}_${s}`.replace(/-/g, ''),
    deleteDatasetByName: jest.fn().mockResolvedValue(undefined),
    addDocuments: jest.fn().mockResolvedValue(undefined),
    cognify: jest.fn().mockResolvedValue(undefined),
    listDatasets: jest.fn().mockResolvedValue([]),
    ...opts.kbOverrides,
  };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  const service = new KbSyncService(
    makeDb({ settings, pages: opts.pages, spaces: opts.spaces }),
    permRepo as any,
    kb as any,
    queue as any,
  );
  return { service, permRepo, kb, queue };
}

describe('KbSyncService.schedulePageSync', () => {
  it('enqueues one debounced job per affected space and connector', async () => {
    const { service, queue } = makeService({
      pages: [{ spaceId: 's1' }, { spaceId: 's2' }],
    });
    await service.schedulePageSync(['p1', 'p2'], WS);

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      'kb-sync-space',
      { connectorId: 'kb1', workspaceId: WS, spaceId: 's1' },
      expect.objectContaining({ jobId: 'kb-sync-kb1-s1' }),
    );
  });

  it('no-ops when no connector has sync enabled', async () => {
    const { service, queue, kb } = makeService();
    kb.getConnectors.mockReturnValue([{ ...CONNECTOR, sync: false }]);
    await service.schedulePageSync(['p1'], WS);
    expect(queue.add).not.toHaveBeenCalled();
  });
});

describe('KbSyncService.syncSpace', () => {
  it('rebuilds the dataset: delete -> add syncable pages -> cognify once', async () => {
    const { service, kb, permRepo } = makeService({
      pages: [
        { id: 'p1', title: 'Open', textContent: 'public text' },
        { id: 'p2', title: 'Secret', textContent: 'classified' },
        { id: 'p3', title: 'Empty', textContent: '' },
      ],
    });
    permRepo.hasRestrictedAncestor.mockImplementation(
      async (id: string) => id === 'p2',
    );

    await service.syncSpace('kb1', WS, 's1');

    const dataset = 'docmost_ws1_s1';
    expect(kb.deleteDatasetByName).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kb1' }),
      dataset,
    );
    // only the open, non-empty page is exported
    expect(kb.addDocuments).toHaveBeenCalledTimes(1);
    const texts = kb.addDocuments.mock.calls[0][2];
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('public text');
    expect(texts[0]).toContain('[docmost:page:p1]');
    expect(texts.join()).not.toContain('classified');
    expect(kb.cognify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kb1' }),
      [dataset],
    );
  });

  it('skips silently when the connector lost its sync flag', async () => {
    const { service, kb } = makeService();
    kb.getConnectors.mockReturnValue([{ ...CONNECTOR, sync: false }]);
    await service.syncSpace('kb1', WS, 's1');
    expect(kb.deleteDatasetByName).not.toHaveBeenCalled();
  });
});

describe('KbSyncService.teardown', () => {
  it('deletes only this workspace\'s datasets', async () => {
    const { service, kb } = makeService({
      kbOverrides: {
        listDatasets: jest.fn().mockResolvedValue([
          { id: 'd1', name: 'docmost_ws1_s1' },
          { id: 'd2', name: 'docmost_ws1_s2' },
          { id: 'd3', name: 'unrelated' },
        ]),
      },
    });
    await service.teardown('kb1', WS);
    expect(kb.deleteDatasetByName).toHaveBeenCalledTimes(2);
    expect(kb.deleteDatasetByName).not.toHaveBeenCalledWith(
      expect.anything(),
      'unrelated',
    );
  });
});

describe('KbSyncService.scheduleBackfill', () => {
  it('schedules a sync for every space in the workspace', async () => {
    const { service, queue } = makeService({
      spaces: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    });
    await service.scheduleBackfill('kb1', WS);
    expect(queue.add).toHaveBeenCalledTimes(3);
  });
});
