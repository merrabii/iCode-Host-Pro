import {
  HOSTING_C3_ENABLED_ENV,
  HOSTING_C3_ENABLED_VALUE,
  isHostingC3Enabled,
} from './c3-flag';

/**
 * 17B.4F-C3 — garde serveur du parcours C3. Contrat IDENTIQUE au gabarit C2
 * (cf. `c2-flag.spec.ts`) : SEULE la valeur d'activation explicite `true`
 * (comparaison stricte, sensible à la casse) active le parcours ; TOUT le reste
 * — absent, vide, `false`, `FALSE`, `1`, `yes`, espaces — est OFF. Jamais de
 * `Boolean("false")` (qui vaut true).
 */
describe('isHostingC3Enabled (17B.4F-C3)', () => {
  it.each([
    ['absente (undefined)', undefined],
    ['vide', ''],
    ['false (valeur de désactivation)', 'false'],
    ['FALSE (casse)', 'FALSE'],
    ['False (casse mixte)', 'False'],
    ['0', '0'],
    ['1', '1'],
    ['yes', 'yes'],
    ['true avec espaces', ' true'],
    ['true suivi d’espaces', 'true '],
    ['true pluriel', 'trues'],
  ])('OFF — %s ⇒ false', (_label, value) => {
    const env: NodeJS.ProcessEnv = {};
    if (value !== undefined) env[HOSTING_C3_ENABLED_ENV] = value;
    expect(isHostingC3Enabled(env)).toBe(false);
  });

  it("ON — exactement la valeur d'activation 'true' ⇒ true", () => {
    expect(isHostingC3Enabled({ [HOSTING_C3_ENABLED_ENV]: 'true' })).toBe(true);
    expect(HOSTING_C3_ENABLED_VALUE).toBe('true');
  });

  it('ne lit QUE la clé de garde (un HOSTING_C3_ENABLED absent malgré autre env)', () => {
    expect(isHostingC3Enabled({ SOMETHING_ELSE: 'true' })).toBe(false);
  });

  it('comparaison stricte : "true" n’est activé par aucun coerceur implicite', () => {
    // Régression anti-`Boolean("false")` : la désactivation explicite ne doit
    // jamais être lue comme une activation.
    expect(Boolean('false')).toBe(true); // le piège que la garde évite
    expect(isHostingC3Enabled({ [HOSTING_C3_ENABLED_ENV]: 'false' })).toBe(false);
  });

  it('la garde est relue À L’APPEL (jamais figée au démarrage)', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(isHostingC3Enabled(env)).toBe(false);
    env[HOSTING_C3_ENABLED_ENV] = 'true';
    expect(isHostingC3Enabled(env)).toBe(true);
    delete env[HOSTING_C3_ENABLED_ENV];
    expect(isHostingC3Enabled(env)).toBe(false);
  });
});
