import WorkspaceAbilityFactory, { isApiRestrictedToAdmins } from './workspace-ability.factory';
import { WorkspaceCaslAction, WorkspaceCaslSubject } from '../interfaces/workspace-ability.type';

const factory = new WorkspaceAbilityFactory({ getSpaceMemberCreateEnabled: () => false } as any);
const ws = (restrictToAdmins?: boolean) =>
  ({ id: 'ws-1', settings: restrictToAdmins === undefined ? {} : { api: { restrictToAdmins } } }) as any;
const canCreateKey = (role: string, workspace: any) =>
  factory.createForUser({ id: 'u', role } as any, workspace).can(WorkspaceCaslAction.Create, WorkspaceCaslSubject.API);

describe('API key creation vs. settings.api.restrictToAdmins', () => {
  it('members may create keys while the setting is off or unset', () => {
    expect(canCreateKey('member', ws())).toBe(true);
    expect(canCreateKey('member', ws(false))).toBe(true);
  });

  it('members may not create keys once the setting is on (enforced server-side)', () => {
    expect(canCreateKey('member', ws(true))).toBe(false);
  });

  it('admins and owners are unaffected', () => {
    expect(canCreateKey('admin', ws(true))).toBe(true);
    expect(canCreateKey('owner', ws(true))).toBe(true);
  });

  it('reads the flag defensively', () => {
    expect(isApiRestrictedToAdmins(null)).toBe(false);
    expect(isApiRestrictedToAdmins({ settings: null } as any)).toBe(false);
    expect(isApiRestrictedToAdmins({ settings: { api: { restrictToAdmins: 'yes' } } } as any)).toBe(false);
  });
});
