import { BadRequestException } from '@nestjs/common';
import { ClientWalletController } from './client-wallet.controller';

/**
 * GO Q8 (item 8) — création de recharge par virement :
 *  - ÉCHEC de création → le justificatif n'étant référencé par aucune ligne,
 *    il est nettoyé (removeProof) puis l'erreur est re-propagée ;
 *  - RÉUSSITE de création puis ÉCHEC d'audit → la recharge ET son justificatif
 *    sont désormais RÉFÉRENCÉS : on ne les supprime JAMAIS (l'échec d'audit est
 *    seulement journalisé, le dépôt a réellement eu lieu).
 */
describe('ClientWalletController — Q8 (preuve référencée jamais supprimée)', () => {
  const user = { sub: 'u1', email: 'alice@example.com', role: 'USER' } as never;
  const dto = { amountCents: 2500 };
  const file = {
    originalname: 'virement.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4'),
  };

  let wallet: {
    ensureOwnedCustomer: jest.Mock;
    persistProof: jest.Mock;
    createRecharge: jest.Mock;
    removeProof: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let controller: ClientWalletController;

  beforeEach(() => {
    wallet = {
      ensureOwnedCustomer: jest.fn().mockResolvedValue({ id: 'c1', email: 'alice@example.com', walletBalanceCents: 0 }),
      persistProof: jest.fn().mockReturnValue({ fileName: 'proof-x.pdf', path: 'proof-x.pdf', mime: 'application/pdf' }),
      createRecharge: jest.fn().mockResolvedValue({
        id: 'rc1',
        reference: 'RCH-ABCDEF0123',
        amountCents: 2500,
        status: 'PENDING',
        createdAt: new Date('2026-10-05'),
        proofFileName: 'proof-x.pdf',
      }),
      removeProof: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    controller = new ClientWalletController(
      wallet as never,
      {} as never,
      audit as never,
    );
  });

  it('création OK + audit ÉCHEC → 201 renvoyé, justificatif JAMAIS supprimé', async () => {
    audit.record.mockRejectedValue(new Error('audit PG indisponible'));

    const out = await controller.createRecharge(user, dto as never, file as never);

    expect(out.reference).toBe('RCH-ABCDEF0123');
    expect(wallet.createRecharge).toHaveBeenCalledTimes(1);
    // GO Q8 : AUCUNE suppression du justificatif déjà référencé.
    expect(wallet.removeProof).not.toHaveBeenCalled();
  });

  it('création ÉCHECEE → justificatif nettoyé (non référencé) + erreur propagée', async () => {
    wallet.createRecharge.mockRejectedValue(new Error('DB down'));

    await expect(
      controller.createRecharge(user, dto as never, file as never),
    ).rejects.toThrow('DB down');
    expect(wallet.removeProof).toHaveBeenCalledWith('proof-x.pdf');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('justificatif absent → 400 avant toute écriture', async () => {
    await expect(
      controller.createRecharge(user, dto as never, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(wallet.persistProof).not.toHaveBeenCalled();
    expect(wallet.createRecharge).not.toHaveBeenCalled();
  });
});
