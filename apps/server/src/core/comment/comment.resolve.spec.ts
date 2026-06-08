// Isolate from the collaboration/Yjs ESM stack that jest can't transform; the
// gateway is only a constructor type here and unused by resolveComment.
jest.mock('../../collaboration/collaboration.gateway', () => ({
  CollaborationGateway: class {},
}));

import { CommentService } from './comment.service';

// focused unit test for resolveComment (constructs the service with mocks for
// only the collaborators it touches)
describe('CommentService.resolveComment', () => {
  let service: CommentService;
  let commentRepo: any;
  let wsService: any;
  const user = { id: 'u1' } as any;

  beforeEach(() => {
    commentRepo = { updateComment: jest.fn().mockResolvedValue(undefined) };
    wsService = { emitCommentEvent: jest.fn() };
    service = new CommentService(
      commentRepo,
      null as any,
      wsService,
      null as any,
      null as any,
      null as any,
    );
  });

  it('stamps resolvedById/resolvedAt and emits an event when resolving', async () => {
    const comment = { id: 'c1', spaceId: 's1', pageId: 'p1' } as any;

    const result = await service.resolveComment(comment, true, user);

    const [patch, id] = commentRepo.updateComment.mock.calls[0];
    expect(id).toBe('c1');
    expect(patch.resolvedById).toBe('u1');
    expect(patch.resolvedAt).toBeInstanceOf(Date);
    expect(result.resolvedById).toBe('u1');
    expect(wsService.emitCommentEvent).toHaveBeenCalledWith(
      's1',
      'p1',
      expect.objectContaining({ operation: 'commentUpdated' }),
    );
  });

  it('clears resolution when unresolving', async () => {
    const comment = {
      id: 'c1',
      spaceId: 's1',
      pageId: 'p1',
      resolvedById: 'u1',
      resolvedAt: new Date(),
    } as any;

    const result = await service.resolveComment(comment, false, user);

    const [patch] = commentRepo.updateComment.mock.calls[0];
    expect(patch.resolvedById).toBeNull();
    expect(patch.resolvedAt).toBeNull();
    expect(result.resolvedById).toBeNull();
  });
});
