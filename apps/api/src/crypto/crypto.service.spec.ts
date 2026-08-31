import { CryptoService, MailCryptoError } from './crypto.service';

describe('CryptoService (Phase 6, ADR-022)', () => {
  const config = { get: jest.fn() };
  let service: CryptoService;

  beforeEach(() => {
    config.get.mockReturnValue('test-master-key');
    service = new CryptoService(config as never);
  });

  it('round-trips a plaintext through encrypt→decrypt', () => {
    const payload = service.encrypt('mon-mot-de-passe-smtp');
    expect(payload).not.toContain('mot-de-passe');
    expect(service.decrypt(payload)).toBe('mon-mot-de-passe-smtp');
  });

  it('produces a different ciphertext on each encrypt (random IV)', () => {
    const a = service.encrypt('same');
    const b = service.encrypt('same');
    expect(a).not.toBe(b);
    expect(service.decrypt(a)).toBe('same');
    expect(service.decrypt(b)).toBe('same');
  });

  it('fails loudly with the wrong key (auth tag mismatch)', () => {
    const payload = service.encrypt('secret');
    config.get.mockReturnValue('a-completely-different-key');
    expect(() => service.decrypt(payload)).toThrow();
  });

  it('fails loudly on a tampered payload', () => {
    const payload = service.encrypt('secret');
    const base64 = Buffer.from(payload, 'base64');
    base64[base64.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => service.decrypt(base64.toString('base64'))).toThrow();
  });

  it('throws MailCryptoError when ENCRYPTION_KEY is missing', () => {
    config.get.mockReturnValue('');
    expect(() => service.encrypt('x')).toThrow(MailCryptoError);
    expect(() => service.encrypt('x')).toThrow(/ENCRYPTION_KEY/);
  });
});
