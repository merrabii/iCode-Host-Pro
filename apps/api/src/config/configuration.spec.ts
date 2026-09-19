import { loadAppConfig, parseTrustProxy } from './configuration';

// Fonction isolée et déterministe : aucune dépendance NestJS, aucune horloge.
// Invariants : défaut « ne faire confiance à personne » ; le littéral true est
// refusé (XFF forgeable) ; seuls presets autorisés / IPv4 / CIDR passent ;
// chaque entrée invalide est ignorée ET journalisée.
describe('parseTrustProxy', () => {
  it('vide/absent → false (X-Forwarded-For jamais honoré)', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('   ')).toBe(false);
  });

  it('false explicite → false, sans avertissement', () => {
    const warn = jest.fn();
    for (const v of ['false', 'FALSE', '0', 'no']) {
      expect(parseTrustProxy(v, warn)).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('le littéral true est REFUSÉ → false + avertissement', () => {
    const warn = jest.fn();
    expect(parseTrustProxy('true', warn)).toBe(false);
    expect(parseTrustProxy('TRUE', warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toMatch(/refusé/);
  });

  it('IPv4 littérales et CIDR valides acceptés (ex. 172.18.0.0/16)', () => {
    expect(parseTrustProxy('127.0.0.1, 10.0.0.0/8, 172.18.0.0/16')).toEqual([
      '127.0.0.1',
      '10.0.0.0/8',
      '172.18.0.0/16',
    ]);
  });

  it('presets autorisés : loopback, linklocal, uniquelocal', () => {
    expect(parseTrustProxy('loopback, uniquelocal')).toEqual(['loopback', 'uniquelocal']);
  });

  it('entrée invalide ignorée et journalisée ; le reste est conservé', () => {
    const warn = jest.fn();
    expect(parseTrustProxy('pirate.example.com, 127.0.0.1, 999.999.0.0/33, loopback', warn)).toEqual([
      '127.0.0.1',
      'loopback',
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('liste entièrement invalide → false + avertissement', () => {
    const warn = jest.fn();
    expect(parseTrustProxy('pirate.example.com', warn)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('un nombre de hops n’est pas supporté : « 1 » est ignoré → false', () => {
    const warn = jest.fn();
    expect(parseTrustProxy('1', warn)).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

// Branchement réel : loadAppConfig transmet bien le callback de journalisation
// (utilisé par app.module via le Logger Nest) et le défaut reste sûr.
describe('loadAppConfig — TRUST_PROXY', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = {
      ...env,
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      PORT: '3001',
      JWT_SECRET: 'test-secret',
    };
  });
  afterEach(() => {
    process.env = env;
  });

  it('absent → trustProxy false, aucun avertissement', () => {
    delete process.env.TRUST_PROXY;
    const warn = jest.fn();
    expect(loadAppConfig(warn).trustProxy).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('valeur valide → liste approuvée, aucun avertissement', () => {
    process.env.TRUST_PROXY = '172.18.0.0/16, loopback';
    const warn = jest.fn();
    expect(loadAppConfig(warn).trustProxy).toEqual(['172.18.0.0/16', 'loopback']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('true → refusé (false) ET journalisé via le callback', () => {
    process.env.TRUST_PROXY = 'true';
    const warn = jest.fn();
    expect(loadAppConfig(warn).trustProxy).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/refusé/);
  });

  it('entrées invalides → ignorées et journalisées une par une', () => {
    process.env.TRUST_PROXY = 'pirate.example.com, 127.0.0.1';
    const warn = jest.fn();
    expect(loadAppConfig(warn).trustProxy).toEqual(['127.0.0.1']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/invalide/);
  });
});
