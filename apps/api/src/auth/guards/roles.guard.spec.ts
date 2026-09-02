import { ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';

function makeContext(role: Role | undefined): ExecutionContext {
  const req = { user: role ? { role } : {} };
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard (rank semantics, ADR-027)', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as never);
  });

  it('reads the roles metadata off the handler/class', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    guard.canActivate(makeContext(Role.ADMIN));
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(ROLES_KEY, expect.anything());
  });

  it('allows anyone when there is no @Roles() metadata', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(makeContext(Role.USER))).toBe(true);
    expect(guard.canActivate(makeContext(undefined))).toBe(true);
  });

  it('ADMIN requirement is satisfied only by ADMIN (rank 99)', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    expect(guard.canActivate(makeContext(Role.ADMIN))).toBe(true);
    expect(guard.canActivate(makeContext(Role.SUPPORT_L3))).toBe(false);
    expect(guard.canActivate(makeContext(Role.SUPPORT_L1))).toBe(false);
    expect(guard.canActivate(makeContext(Role.USER))).toBe(false);
  });

  it('SUPPORT_L1 requirement is satisfied by L1/L2/L3/ADMIN but not USER', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.SUPPORT_L1]);
    expect(guard.canActivate(makeContext(Role.ADMIN))).toBe(true);
    expect(guard.canActivate(makeContext(Role.SUPPORT_L3))).toBe(true);
    expect(guard.canActivate(makeContext(Role.SUPPORT_L2))).toBe(true);
    expect(guard.canActivate(makeContext(Role.SUPPORT_L1))).toBe(true);
    expect(guard.canActivate(makeContext(Role.USER))).toBe(false);
  });

  it('SUPPORT_L2 requirement rejects L1 (hierarchy negative)', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.SUPPORT_L2]);
    expect(guard.canActivate(makeContext(Role.SUPPORT_L1))).toBe(false);
    expect(guard.canActivate(makeContext(Role.SUPPORT_L2))).toBe(true);
    expect(guard.canActivate(makeContext(Role.USER))).toBe(false);
  });

  it('SUPPORT_L3 requirement rejects L2 (hierarchy negative)', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.SUPPORT_L3]);
    expect(guard.canActivate(makeContext(Role.SUPPORT_L2))).toBe(false);
    expect(guard.canActivate(makeContext(Role.SUPPORT_L3))).toBe(true);
    expect(guard.canActivate(makeContext(Role.ADMIN))).toBe(true);
  });

  it('anti-escalation: an impersonation JWT (role USER pinned) can never clear support/admin', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.SUPPORT_L1]);
    const req = { user: { role: Role.USER, imp: { by: 'a1', kind: 'admin' } } };
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(context)).toBe(false);
  });
});
