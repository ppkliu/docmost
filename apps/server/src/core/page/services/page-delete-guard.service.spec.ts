import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  DELETE_CONFIRM_TTL_MS,
  PageDeleteGuardService,
  signDeleteToken,
  verifyDeleteToken,
} from './page-delete-guard.service';

const SECRET = 'test-secret';
const page = { id: 'page-1', title: 'Q3 report', spaceId: 'space-1' } as any;
const user = { id: 'user-1' } as any;
const workspace = { id: 'ws-1', trashRetentionDays: 14 } as any;

// Minimal Kysely stand-in: every builder call returns itself; the two terminal
// calls answer from the child rows configured for the test.
function fakeDb(children: { id: string; title: string }[]) {
  const builder: any = {};
  for (const m of ['selectFrom', 'select', 'where', 'orderBy']) {
    builder[m] = () => builder;
  }
  builder.limit = (n: number) => ({ execute: async () => children.slice(0, n) });
  builder.executeTakeFirst = async () => ({ n: children.length });
  return builder;
}

function guard(children: { id: string; title: string }[] = []) {
  return new PageDeleteGuardService(fakeDb(children), {
    getAppSecret: () => SECRET,
  } as any);
}

async function rejection(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as any;
  }
  throw new Error('expected a rejection');
}

describe('delete confirmation token', () => {
  const claims = { p: 'page-1', m: 'trash' as const, u: 'user-1' };

  it('accepts a token only for the same page, mode and user, before it expires', () => {
    const now = Date.now();
    const token = signDeleteToken({ ...claims, e: now + 1000 }, SECRET);
    expect(verifyDeleteToken(token, claims, SECRET, now)).toBeNull();
    expect(verifyDeleteToken(token, { ...claims, p: 'page-2' }, SECRET, now)).toBe('other_page');
    expect(verifyDeleteToken(token, { ...claims, m: 'permanent' }, SECRET, now)).toBe('other_mode');
    expect(verifyDeleteToken(token, { ...claims, u: 'user-2' }, SECRET, now)).toBe('other_user');
    expect(verifyDeleteToken(token, claims, SECRET, now + 1000)).toBe('expired');
  });

  it('rejects tokens signed with another secret or tampered with', () => {
    const token = signDeleteToken({ ...claims, e: Date.now() + 1000 }, 'other');
    expect(verifyDeleteToken(token, claims, SECRET)).toBe('signature');
    const [, sig] = signDeleteToken({ ...claims, e: Date.now() + 1000 }, SECRET).split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, p: 'page-2', e: Date.now() + 1000 })).toString('base64url');
    expect(verifyDeleteToken(`${forged}.${sig}`, { ...claims, p: 'page-2' }, SECRET)).toBe('signature');
    expect(verifyDeleteToken('garbage', claims, SECRET)).toBe('malformed');
  });
});

describe('PageDeleteGuardService', () => {
  it('only applies to API-key requests', () => {
    const g = guard();
    expect(g.isApiKeyRequest({ raw: { authType: 'api_key' } })).toBe(true);
    expect(g.isApiKeyRequest({ raw: {} })).toBe(false);
  });

  it('refuses a page with child pages, listing them and what to do next', async () => {
    const err = await rejection(
      guard([
        { id: 'c1', title: 'Child A' },
        { id: 'c2', title: 'Child B' },
      ]).assertDeletable({ page, user, workspace }),
    );
    expect(err).toBeInstanceOf(ConflictException);
    const body = err.getResponse();
    expect(body.code).toBe('PAGE_HAS_CHILDREN');
    expect(body.childPages).toBe(2);
    expect(body.children).toEqual([
      { id: 'c1', title: 'Child A' },
      { id: 'c2', title: 'Child B' },
    ]);
    expect(body.rule).toMatch(/must not have child pages/);
    expect(body.nextSteps.length).toBeGreaterThan(0);
  });

  it('refuses children even when a valid token is supplied', async () => {
    const token = signDeleteToken({ p: 'page-1', m: 'trash', u: 'user-1', e: Date.now() + 60000 }, SECRET);
    const err = await rejection(
      guard([{ id: 'c1', title: 'x' }]).assertDeletable({ page, user, workspace, confirmToken: token, confirmedBy: 'Ann' }),
    );
    expect(err.getResponse().code).toBe('PAGE_HAS_CHILDREN');
  });

  it('first call returns a warning and a token instead of deleting', async () => {
    const err = await rejection(guard().assertDeletable({ page, user, workspace }));
    const body = err.getResponse();
    expect(body.code).toBe('CONFIRMATION_REQUIRED');
    expect(body.mode).toBe('trash');
    expect(body.warning).toContain('Q3 report');
    expect(body.warning).toContain('14 days');
    expect(body.agentInstructions.join(' ')).toMatch(/Do not resend this request automatically/);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(DELETE_CONFIRM_TTL_MS);
    expect(verifyDeleteToken(body.confirmToken, { p: 'page-1', m: 'trash', u: 'user-1' }, SECRET)).toBeNull();
  });

  it('warns that a permanent delete cannot be undone', async () => {
    const err = await rejection(guard().assertDeletable({ page, user, workspace, permanentlyDelete: true }));
    const body = err.getResponse();
    expect(body.mode).toBe('permanent');
    expect(body.warning).toMatch(/PERMANENTLY/);
    expect(body.warning).toMatch(/cannot be undone/);
  });

  it('second call with the token and confirmedBy is allowed and returns the approver', async () => {
    const first = (await rejection(guard().assertDeletable({ page, user, workspace }))).getResponse();
    await expect(
      guard().assertDeletable({ page, user, workspace, confirmToken: first.confirmToken, confirmedBy: '  ann@example.com ' }),
    ).resolves.toEqual({ confirmedBy: 'ann@example.com' });
  });

  it('a token issued for trash cannot confirm a permanent delete', async () => {
    const first = (await rejection(guard().assertDeletable({ page, user, workspace }))).getResponse();
    const err = await rejection(
      guard().assertDeletable({ page, user, workspace, permanentlyDelete: true, confirmToken: first.confirmToken, confirmedBy: 'Ann' }),
    );
    const body = err.getResponse();
    expect(body.code).toBe('CONFIRMATION_INVALID');
    expect(body.message).toMatch(/other delete mode/);
    expect(body.confirmToken).toBeUndefined();
  });

  it('a valid token without confirmedBy is rejected', async () => {
    const first = (await rejection(guard().assertDeletable({ page, user, workspace }))).getResponse();
    const err = await rejection(guard().assertDeletable({ page, user, workspace, confirmToken: first.confirmToken }));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().code).toBe('CONFIRMED_BY_REQUIRED');
  });
});
