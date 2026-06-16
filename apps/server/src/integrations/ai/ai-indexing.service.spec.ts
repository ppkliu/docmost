import { AiIndexingService } from './ai-indexing.service';

// chainable kysely stub: workspaces lookups return {settings}, pages lookups
// return the given page row (or undefined).
function dbReturning(settings: unknown, pageRow?: unknown) {
  const chain = (result: unknown) => ({
    select: () => ({
      where: () => ({
        executeTakeFirst: async () => result,
        where: () => ({ executeTakeFirst: async () => result }),
      }),
    }),
  });
  return {
    selectFrom: (table: string) =>
      table === 'pages' ? chain(pageRow) : chain({ settings }),
  } as any;
}

describe('AiIndexingService', () => {
  let embeddingRepo: any;
  let permRepo: any;
  let provider: any;

  beforeEach(() => {
    embeddingRepo = {
      deleteByPageIds: jest.fn().mockResolvedValue(undefined),
      deleteByWorkspace: jest.fn().mockResolvedValue(undefined),
      replacePageChunks: jest.fn().mockResolvedValue(undefined),
      listWorkspacePageIds: jest.fn().mockResolvedValue([]),
    };
    permRepo = {
      hasRestrictedAncestor: jest.fn().mockResolvedValue(false),
    };
    provider = {
      resolveConfig: jest
        .fn()
        .mockReturnValue({ embeddingModel: 'text-embedding-3-small' }),
      isEmbeddingConfigured: jest.fn().mockReturnValue(true),
      embeddingModel: jest.fn().mockReturnValue({}),
      embeddingDimension: jest.fn().mockReturnValue(1536),
    };
  });

  const make = (settings: unknown, pageRow?: unknown) =>
    new AiIndexingService(
      dbReturning(settings, pageRow),
      embeddingRepo,
      permRepo,
      provider,
    );

  describe('isEnabled', () => {
    it('is false when embeddings are not configured', async () => {
      provider.isEmbeddingConfigured.mockReturnValue(false);
      const svc = make({ ai: { search: true } });
      expect(await svc.isEnabled('ws-1')).toBe(false);
    });

    it('is false when the workspace has AI Search off', async () => {
      const svc = make({ ai: { search: false } });
      expect(await svc.isEnabled('ws-1')).toBe(false);
    });

    it('is true when configured and AI Search is on', async () => {
      const svc = make({ ai: { search: true } });
      expect(await svc.isEnabled('ws-1')).toBe(true);
    });
  });

  describe('embedPages', () => {
    it('no-ops (no embed, no write) when disabled', async () => {
      const svc = make({ ai: { search: false } });
      await svc.embedPages(['p1'], 'ws-1');
      expect(provider.embeddingModel).not.toHaveBeenCalled();
      expect(embeddingRepo.replacePageChunks).not.toHaveBeenCalled();
    });

    it('no-ops for an empty page list', async () => {
      const svc = make({ ai: { search: true } });
      await svc.embedPages([], 'ws-1');
      expect(provider.embeddingModel).not.toHaveBeenCalled();
    });

    it('H2.2: keeps pending-review pages out of the retrieval store', async () => {
      const svc = make(
        { ai: { search: true } },
        { id: 'p1', textContent: 'draft', spaceId: 's1', workspaceId: 'ws-1', deletedAt: null, reviewStatus: 'pending' },
      );

      await svc.embedPages(['p1'], 'ws-1');

      expect(embeddingRepo.deleteByPageIds).toHaveBeenCalledWith(['p1']);
      expect(embeddingRepo.replacePageChunks).not.toHaveBeenCalled();
    });

    it('K4.2: drops restricted pages from the retrieval store instead of embedding', async () => {
      permRepo.hasRestrictedAncestor.mockResolvedValue(true);
      const svc = make(
        { ai: { search: true } },
        { id: 'p1', textContent: 'secret', spaceId: 's1', workspaceId: 'ws-1', deletedAt: null },
      );

      await svc.embedPages(['p1'], 'ws-1');

      expect(permRepo.hasRestrictedAncestor).toHaveBeenCalledWith('p1');
      expect(embeddingRepo.deleteByPageIds).toHaveBeenCalledWith(['p1']);
      expect(embeddingRepo.replacePageChunks).not.toHaveBeenCalled();
    });
  });

  describe('delete paths', () => {
    it('deletePages delegates to the repo', async () => {
      const svc = make({});
      await svc.deletePages(['p1', 'p2']);
      expect(embeddingRepo.deleteByPageIds).toHaveBeenCalledWith(['p1', 'p2']);
    });

    it('deleteWorkspace delegates to the repo', async () => {
      const svc = make({});
      await svc.deleteWorkspace('ws-9');
      expect(embeddingRepo.deleteByWorkspace).toHaveBeenCalledWith('ws-9');
    });

    it('backfill no-ops when disabled', async () => {
      const svc = make({ ai: { search: false } });
      await svc.backfillWorkspace('ws-1');
      expect(embeddingRepo.listWorkspacePageIds).not.toHaveBeenCalled();
    });
  });
});
