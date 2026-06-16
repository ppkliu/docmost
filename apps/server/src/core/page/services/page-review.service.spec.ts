import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PageReviewService } from './page-review.service';

const PAGE = {
  id: 'page-1',
  spaceId: 'space-1',
  workspaceId: 'ws-1',
  reviewStatus: 'pending',
} as any;
const USER = { id: 'u1' } as any;

function makeService(overrides: Record<string, any> = {}) {
  const deps = {
    db: {},
    pageRepo: {
      updatePage: jest.fn().mockResolvedValue(undefined),
      removePage: jest.fn().mockResolvedValue(undefined),
    },
    commentRepo: { insertComment: jest.fn().mockResolvedValue({ id: 'c1' }) },
    spaceAbility: {
      createForUser: jest.fn().mockResolvedValue({
        cannot: () => false,
      }),
    },
    permService: {
      getRestrictionInfo: jest.fn().mockResolvedValue({
        userAccess: { canView: true, canEdit: true, canManage: true },
      }),
    },
    aiQueue: { add: jest.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
  const service = new PageReviewService(
    deps.db as any,
    deps.pageRepo as any,
    deps.commentRepo as any,
    deps.spaceAbility as any,
    deps.permService as any,
    deps.aiQueue as any,
  );
  return { service, deps };
}

describe('PageReviewService.review', () => {
  it('approves: sets approved and re-admits the page to indexing', async () => {
    const { service, deps } = makeService();
    const out = await service.review(PAGE, USER, 'approve');

    expect(out).toEqual({ pageId: 'page-1', reviewStatus: 'approved' });
    expect(deps.pageRepo.updatePage).toHaveBeenCalledWith(
      { reviewStatus: 'approved' },
      'page-1',
    );
    expect(deps.aiQueue.add).toHaveBeenCalledWith(
      'generate-page-embeddings',
      { pageIds: ['page-1'], workspaceId: 'ws-1' },
    );
    expect(deps.pageRepo.removePage).not.toHaveBeenCalled();
  });

  it('rejects: leaves a note comment and trashes the page', async () => {
    const { service, deps } = makeService();
    const out = await service.review(PAGE, USER, 'reject', 'duplicate of X');

    expect(out.reviewStatus).toBe('rejected');
    expect(deps.commentRepo.insertComment).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: 'page-1',
        creatorId: 'u1',
        content: expect.objectContaining({ type: 'doc' }),
      }),
    );
    expect(deps.pageRepo.updatePage).toHaveBeenCalledWith(
      { reviewStatus: 'rejected' },
      'page-1',
    );
    expect(deps.pageRepo.removePage).toHaveBeenCalledWith(
      'page-1',
      'u1',
      'ws-1',
    );
  });

  it('rejects without a note when none is given', async () => {
    const { service, deps } = makeService();
    await service.review(PAGE, USER, 'reject');
    expect(deps.commentRepo.insertComment).not.toHaveBeenCalled();
  });

  it('only pending pages can be reviewed', async () => {
    const { service } = makeService();
    await expect(
      service.review({ ...PAGE, reviewStatus: null }, USER, 'approve'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.review({ ...PAGE, reviewStatus: 'approved' }, USER, 'approve'),
    ).rejects.toThrow(BadRequestException);
  });

  it('requires manage rights on the page', async () => {
    const { service } = makeService({
      permService: {
        getRestrictionInfo: jest.fn().mockResolvedValue({
          userAccess: { canView: true, canEdit: false, canManage: false },
        }),
      },
    });
    await expect(service.review(PAGE, USER, 'approve')).rejects.toThrow(
      ForbiddenException,
    );
  });
});

describe('PageReviewService.listQueue', () => {
  it('requires space page-manage rights', async () => {
    const { service } = makeService({
      spaceAbility: {
        createForUser: jest.fn().mockResolvedValue({ cannot: () => true }),
      },
    });
    await expect(
      service.listQueue('space-1', USER, 'ws-1'),
    ).rejects.toThrow(ForbiddenException);
  });
});
