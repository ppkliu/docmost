import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Page, User, Workspace } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { getPageTitle } from '../../../common/helpers';

/** How long a confirmation token stays valid after the warning is issued. */
export const DELETE_CONFIRM_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TRASH_RETENTION_DAYS = 30;
const LISTED_CHILDREN = 20;

type DeleteMode = 'trash' | 'permanent';

interface TokenClaims {
  p: string; // page id
  m: DeleteMode;
  u: string; // user id the warning was issued to
  e: number; // expiry, epoch ms
}

export function signDeleteToken(claims: TokenClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`page-delete.${body}`).digest('base64url');
  return `${body}.${sig}`;
}

/** Returns the reason the token is unusable, or null when it is valid for this exact delete. */
export function verifyDeleteToken(
  token: string,
  expected: Omit<TokenClaims, 'e'>,
  secret: string,
  now = Date.now(),
): string | null {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return 'malformed';
  const want = createHmac('sha256', secret).update(`page-delete.${body}`).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return 'signature';
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return 'malformed';
  }
  if (!(claims.e > now)) return 'expired';
  if (claims.p !== expected.p) return 'other_page';
  if (claims.m !== expected.m) return 'other_mode';
  if (claims.u !== expected.u) return 'other_user';
  return null;
}

const INVALID_REASONS: Record<string, string> = {
  malformed: 'confirmToken is not a token issued by this server',
  signature: 'confirmToken is not a token issued by this server',
  expired: `confirmToken expired (valid for ${DELETE_CONFIRM_TTL_MS / 60000} minutes)`,
  other_page: 'confirmToken was issued for a different page',
  other_mode: 'confirmToken was issued for the other delete mode (trash vs permanentlyDelete)',
  other_user: 'confirmToken was issued to a different user or API key owner',
};

/**
 * Extra rules for deleting a page with an API key — the way agents and
 * scripts reach Docmost. Browser sessions are not affected: the web UI
 * already asks the person before deleting.
 *
 * 1. A page that still has child pages cannot be deleted. Docmost trashes
 *    (or permanently deletes) the whole subtree with it, which an automated
 *    caller rarely means to do. The children must be moved or deleted first.
 * 2. Every delete is two calls. The first returns 409 CONFIRMATION_REQUIRED
 *    with a warning and a short-lived confirmToken; the caller must show the
 *    warning to a person, get explicit approval, and repeat the call with the
 *    token and `confirmedBy` (who approved). The server cannot prove a person
 *    approved — the token proves the caller received the warning, and
 *    `confirmedBy` is written to the audit log so the approval is attributable.
 */
@Injectable()
export class PageDeleteGuardService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
  ) {}

  isApiKeyRequest(req: any): boolean {
    return req?.raw?.authType === 'api_key';
  }

  /**
   * Throws when the delete must not go ahead yet. Returns the approver
   * (`confirmedBy`) to record in the audit log when it may.
   */
  async assertDeletable(args: {
    page: Page;
    user: User;
    workspace: Workspace;
    permanentlyDelete?: boolean;
    confirmToken?: string;
    confirmedBy?: string;
  }): Promise<{ confirmedBy: string }> {
    const { page, user, workspace } = args;
    const mode: DeleteMode = args.permanentlyDelete ? 'permanent' : 'trash';
    const title = getPageTitle(page.title);

    const children = await this.db
      .selectFrom('pages')
      .select(['id', 'title'])
      .where('parentPageId', '=', page.id)
      .where('deletedAt', 'is', null)
      .orderBy('position', (ob) => ob.collate('C').asc())
      .limit(LISTED_CHILDREN + 1)
      .execute();
    if (children.length > 0) {
      const total =
        children.length > LISTED_CHILDREN
          ? Number(
              (
                await this.db
                  .selectFrom('pages')
                  .select((eb) => eb.fn.countAll().as('n'))
                  .where('parentPageId', '=', page.id)
                  .where('deletedAt', 'is', null)
                  .executeTakeFirst()
              )?.n ?? children.length,
            )
          : children.length;
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'PAGE_HAS_CHILDREN',
        message: `Page "${title}" still has ${total} child page(s). Deleting it would also delete all of them, so API deletes are refused until it has none.`,
        rule: 'A page deleted with an API key must not have child pages. Docmost deletes a page together with its whole subtree.',
        page: { id: page.id, title },
        childPages: total,
        children: children.slice(0, LISTED_CHILDREN).map((c) => ({
          id: c.id,
          title: getPageTitle(c.title),
        })),
        nextSteps: [
          'Move each child page elsewhere (POST /api/pages/move) or delete it first; each child delete needs its own confirmation.',
          'Then call POST /api/pages/delete for this page again.',
        ],
      });
    }

    const secret = this.environmentService.getAppSecret();
    const expected = { p: page.id, m: mode, u: user.id };

    if (!args.confirmToken) {
      const expiresAt = Date.now() + DELETE_CONFIRM_TTL_MS;
      const retentionDays =
        (workspace as any).trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS;
      const effect =
        mode === 'permanent'
          ? 'The page, its history, comments and attachment files will be permanently deleted. This cannot be undone.'
          : `The page will be moved to the trash. It can be restored from the trash for ${retentionDays} days, then it is deleted permanently.`;
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'CONFIRMATION_REQUIRED',
        message: `Deleting "${title}" needs explicit approval from a person. Nothing has been deleted.`,
        rule: 'Every page delete made with an API key is two calls: this warning first, then the same call with confirmToken and confirmedBy.',
        warning: `You are about to ${mode === 'permanent' ? 'PERMANENTLY delete' : 'delete'} the page "${title}". ${effect}`,
        page: { id: page.id, title, spaceId: page.spaceId },
        mode,
        confirmToken: signDeleteToken({ ...expected, e: expiresAt }, secret),
        expiresAt: new Date(expiresAt).toISOString(),
        agentInstructions: [
          'Do not resend this request automatically.',
          'Show the "warning" text to the user exactly as given and ask whether to proceed.',
          'Only if the user explicitly agrees, repeat the same request with "confirmToken" and "confirmedBy" (the name or email of the person who approved).',
          `The token is valid for ${DELETE_CONFIRM_TTL_MS / 60000} minutes and only for this page, this delete mode and this API key owner.`,
        ],
      });
    }

    const invalid = verifyDeleteToken(args.confirmToken, expected, secret);
    if (invalid) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'CONFIRMATION_INVALID',
        message: `${INVALID_REASONS[invalid]}. Nothing has been deleted.`,
        rule: 'A confirmToken is valid only for the page, delete mode and user it was issued for, and only until it expires.',
        nextSteps: [
          'Call POST /api/pages/delete again without confirmToken to get a new warning, and ask the user again.',
        ],
      });
    }

    const confirmedBy = String(args.confirmedBy ?? '').trim();
    if (!confirmedBy) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'CONFIRMED_BY_REQUIRED',
        message: 'confirmedBy is required together with confirmToken: name or email of the person who approved the delete. Nothing has been deleted.',
        rule: 'Approved deletes record who approved them in the audit log.',
      });
    }
    return { confirmedBy };
  }
}
