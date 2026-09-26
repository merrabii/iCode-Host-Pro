import {
  HOSTING_C2_ENABLED_ENV,
  HOSTING_C2_ENABLED_VALUE,
  isHostingC2Enabled,
} from './c2-flag';

/**
 * 17B.4F-C2 — garde serveur du parcours C2. Contrat : SEULE la valeur
 * d'activation explicite `true` (comparaison stricte, sensible à la casse)
 * active le parcours ; TOUT le reste — absent, vide, `false`, `FALSE`, `1`,
 * `yes`, espaces — est OFF. Jamais de `Boolean("false")` (qui vaut true).
 */
describe('isHostingC2Enabled (17B.4F-C2)', () => {
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
    if (value !== undefined) env[HOSTING_C2_ENABLED_ENV] = value;
    expect(isHostingC2Enabled(env)).toBe(false);
  });

  it("ON — exactement la valeur d'activation 'true' ⇒ true", () => {
    expect(isHostingC2Enabled({ [HOSTING_C2_ENABLED_ENV]: 'true' })).toBe(true);
    expect(HOSTING_C2_ENABLED_VALUE).toBe('true');
  });

  it('ne lit QUE la clé de garde (un HOSTING_C2_ENABLED absent malgré autre env)', () => {
    expect(isHostingC2Enabled({ SOMETHING_ELSE: 'true' })).toBe(false);
  });

  it('comparaison stricte : "true" n’est activé par aucun coerceur implicite', () => {
    // Régression anti-`Boolean("false")` : la désactivation explicite ne doit
    // jamais être lue comme une activation.
    expect(Boolean('false')).toBe(true); // le piège que la garde évite
    expect(isHostingC2Enabled({ [HOSTING_C2_ENABLED_ENV]: 'false' })).toBe(false);
  });
});
