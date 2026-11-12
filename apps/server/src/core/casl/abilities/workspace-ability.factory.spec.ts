import WorkspaceAbilityFactory, { isApiRestrictedToAdmins } from './workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../interfaces/workspace-ability.type';

const factory = new WorkspaceAbilityFactory({ getSpaceMemberCreateEnabled: () => false } as any);
const ws = (restrictToAdmins?: boolean) =>
  ({ id: 'ws-1', settings: restrictToAdmins === undefined ? {} : { api: { restrictToAdmins } } }) as any;
const canCreateKey = (role: string, workspace: any) =>
  factory.createForUser({ id: 'u', role } as any, workspace).can(WorkspaceCaslAction.Create, WorkspaceCaslSubject.API);

describe('API key creation vs. settings.api.restrictToAdmins', () => {
  it('members may not create keys by default (setting unset)', () => {
    expect(canCreateKey('member', ws())).toBe(false);
    expect(canCreateKey('member', { id: 'ws-1', settings: null } as any)).toBe(false);
  });

  it('members may not create keys while the setting is on (enforced server-side)', () => {
    expect(canCreateKey('member', ws(true))).toBe(false);
  });

  it('members may create keys only after an admin explicitly turns the setting off', () => {
    expect(canCreateKey('member', ws(false))).toBe(true);
  });

  it('admins and owners are unaffected', () => {
    expect(canCreateKey('admin', ws(true))).toBe(true);
    expect(canCreateKey('owner', ws(true))).toBe(true);
  });

  it('treats anything but an explicit false as restricted', () => {
    expect(isApiRestrictedToAdmins(null)).toBe(true);
    expect(isApiRestrictedToAdmins({ settings: null } as any)).toBe(true);
    expect(isApiRestrictedToAdmins({ settings: { api: {} } } as any)).toBe(true);
    expect(isApiRestrictedToAdmins({ settings: { api: { restrictToAdmins: 'no' } } } as any)).toBe(true);
    expect(isApiRestrictedToAdmins({ settings: { api: { restrictToAdmins: false } } } as any)).toBe(false);
  });
});
