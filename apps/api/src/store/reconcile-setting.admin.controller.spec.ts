import { Role } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ReconcileSettingAdminController } from './reconcile-setting.admin.controller';
import { ReconcileSettingsService } from './reconcile-settings.service';

// 17B.4C1 — surface HTTP admin des réglages de réconciliation : délégation au
// service + contrat ADMIN strict (JwtAuthGuard + RolesGuard + Roles(ADMIN),
// même protection que /admin/security). Aucun endpoint public.
describe('ReconcileSettingAdminController (17B.4C1)', () => {
  const view = {
    overrides: { batchSize: 7 },
    effective: { enabled: true } as never,
    sources: { batchSize: 'DATABASE' } as never,
    createdAt: null,
    updatedAt: null,
  };
  const actor = { sub: 'adm-1', email: 'admin@example.com' };

  function make(over: { getView?: jest.Mock; update?: jest.Mock; reset?: jest.Mock }) {
    const settings = {
      getView: over.getView ?? jest.fn(async () => view),
      update: over.update ?? jest.fn(async () => view),
      reset: over.reset ?? jest.fn(async () => view),
    };
    const ctrl = new ReconcileSettingAdminController(settings as unknown as ReconcileSettingsService);
    return { ctrl, settings };
  }

  it('GET délègue à getView()', async () => {
    const { ctrl, settings } = make({});
    await expect(ctrl.get()).resolves.toBe(view);
    expect(settings.getView).toHaveBeenCalledTimes(1);
  });

  it('PATCH délègue dto + acteur extrait du JwtPayload', async () => {
    const update = jest.fn(async () => view);
    const { ctrl } = make({ update });
    await expect(ctrl.update({ batchSize: 42 }, actor as never)).resolves.toBe(view);
    expect(update).toHaveBeenCalledWith({ batchSize: 42 }, { sub: 'adm-1', email: 'admin@example.com' });
  });

  it('POST reset délègue reset() avec l\'acteur', async () => {
    const reset = jest.fn(async () => view);
    const { ctrl } = make({ reset });
    await expect(ctrl.reset(actor as never)).resolves.toBe(view);
    expect(reset).toHaveBeenCalledWith({ sub: 'adm-1', email: 'admin@example.com' });
  });

  it('contrat ADMIN : route /admin/reconcile + rôle ADMIN', () => {
    const metadata = Reflect.getMetadata('path', ReconcileSettingAdminController);
    const roles = Reflect.getMetadata(ROLES_KEY, ReconcileSettingAdminController);
    expect(metadata).toBe('admin/reconcile');
    expect(roles).toEqual([Role.ADMIN]);
    const guards = Reflect.getMetadata('__guards__', ReconcileSettingAdminController) as unknown[];
    expect(guards?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});