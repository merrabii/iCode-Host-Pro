import { BadRequestException } from '@nestjs/common';
import { GithubService, suggestBuildPack } from './github.service';

// Phase 10bis (M) — unit de GitHubService : le fetch natif est stubé (aucun
// réseau réel), le token chiffré est déchiffré par un CryptoService mocké.
describe('GithubService', () => {
  const mockCrypto = { encrypt: jest.fn(), decrypt: jest.fn() };
  let service: GithubService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new GithubService(mockCrypto as never);
    mockCrypto.decrypt.mockReturnValue('gh-token');
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  describe('decryptToken()', () => {
    it('400 clair quand aucun token n’est stocké', () => {
      expect(() => service.decryptToken(null)).toThrow(BadRequestException);
    });

    it('déchiffre le token stocké', () => {
      mockCrypto.decrypt.mockReturnValue('gh-token');
      expect(service.decryptToken('enc:gh')).toBe('gh-token');
      expect(mockCrypto.decrypt).toHaveBeenCalledWith('enc:gh');
    });
  });

  describe('listRepos()', () => {
    it('mappe la réponse /user/repos (full_name, default_branch, private, language)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [
          { full_name: 'owner/repo-a', default_branch: 'main', private: false, language: 'TypeScript' },
          { full_name: 'owner/repo-b', default_branch: 'master', private: true, language: null },
        ],
      });
      const repos = await service.listRepos('gh-token');
      expect(repos).toEqual([
        { fullName: 'owner/repo-a', defaultBranch: 'main', private: false, language: 'TypeScript' },
        { fullName: 'owner/repo-b', defaultBranch: 'master', private: true, language: null },
      ]);
      // Le token est envoyé en Bearer sur l'API GitHub.
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('api.github.com/user/repos');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gh-token');
    });

    it('renvoie [] quand la réponse n’est pas un tableau', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ not: 'array' }) });
      await expect(service.listRepos('gh-token')).resolves.toEqual([]);
    });

    it('propage une 400 lisible sur erreur GitHub (403 rate-limit)', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'rate limit exceeded',
      });
      await expect(service.listRepos('gh-token')).rejects.toThrow(/403/);
    });
  });

  describe('repoExists()', () => {
    it('true quand le dépôt est accessible', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ full_name: 'owner/repo' }) });
      await expect(service.repoExists('gh-token', 'owner/repo')).resolves.toBe(true);
    });

    it('false sur 404 (dépôt absent/transféré) — jamais rejeté', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' });
      await expect(service.repoExists('gh-token', 'owner/repo')).resolves.toBe(false);
    });
  });

  describe('fetchUser()', () => {
    it('renvoie le login du compte', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ login: 'octocat' }) });
      await expect(service.fetchUser('gh-token')).resolves.toEqual({ login: 'octocat' });
    });
  });

  // ── Phase 10bis.5 — détection auto (URL collée) ────────────────────────────
  describe('parseGithubUrl()', () => {
    it('extrait owner/repo d’une URL github.com simple', () => {
      expect(GithubService.parseGithubUrl('https://github.com/owner/repo')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('retire le suffixe .git', () => {
      expect(GithubService.parseGithubUrl('https://github.com/owner/repo.git')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('ignore /tree/ et /blob/', () => {
      expect(GithubService.parseGithubUrl('https://github.com/owner/repo/tree/develop/src')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
      expect(GithubService.parseGithubUrl('https://github.com/owner/repo/blob/main/README.md')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('null hors github.com ou chemin trop court', () => {
      expect(GithubService.parseGithubUrl('https://gitlab.com/foo/bar')).toBeNull();
      expect(GithubService.parseGithubUrl('https://github.com/owner')).toBeNull();
      expect(GithubService.parseGithubUrl('pas-une-url')).toBeNull();
    });
  });

  describe('sanitizeGitUrl()', () => {
    it('trim + retire le fragment + normalise le slash final', () => {
      expect(GithubService.sanitizeGitUrl('  https://github.com/owner/repo.git#readme  ')).toBe(
        'https://github.com/owner/repo.git',
      );
      expect(GithubService.sanitizeGitUrl('https://github.com/owner/repo/')).toBe(
        'https://github.com/owner/repo',
      );
    });

    it('refuse les protocoles non-http(s)', () => {
      expect(() => GithubService.sanitizeGitUrl('git@github.com:owner/repo.git')).toThrow(
        BadRequestException,
      );
      expect(() => GithubService.sanitizeGitUrl('ftp://x/y')).toThrow(BadRequestException);
    });

    it('refuse les hôtes privés/réservés (SSRF léger)', () => {
      expect(() => GithubService.sanitizeGitUrl('http://localhost/repo')).toThrow(BadRequestException);
      expect(() => GithubService.sanitizeGitUrl('http://127.0.0.1/repo')).toThrow(BadRequestException);
      expect(() => GithubService.sanitizeGitUrl('http://192.168.1.10/repo')).toThrow(BadRequestException);
      expect(() => GithubService.sanitizeGitUrl('http://10.0.0.5/x')).toThrow(BadRequestException);
      expect(() => GithubService.sanitizeGitUrl('http://172.20.0.1/x')).toThrow(BadRequestException);
    });

    it('refuse une URL vide ou invalide', () => {
      expect(() => GithubService.sanitizeGitUrl('   ')).toThrow(BadRequestException);
      expect(() => GithubService.sanitizeGitUrl('https://')).toThrow(BadRequestException);
    });
  });

  describe('detectRepo()', () => {
    it('github.com : détecte branche + langage + build pack, SANS Authorization', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).includes('/contents/Dockerfile')) {
          return { ok: false, status: 404, json: async () => null };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ default_branch: 'main', language: 'TypeScript' }),
        };
      });
      const out = await service.detectRepo('https://github.com/octocat/hello.git');
      expect(out.valid).toBe(true);
      expect(out.repoFullName).toBe('octocat/hello');
      expect(out.defaultBranch).toBe('main');
      expect(out.language).toBe('TypeScript');
      expect(out.suggestedBuildPack).toBe('nixpacks');
      expect(out.repoUrl).toBe('https://github.com/octocat/hello.git');
      // Aucun header Authorization sur les appels de détection.
      for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
        expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
      }
    });

    it('Dockerfile détecté ⇒ build pack dockerfile', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (String(url).includes('/contents/Dockerfile')) {
          return { ok: true, status: 200, json: async () => ({ name: 'Dockerfile' }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ default_branch: 'main', language: null }),
        };
      });
      const out = await service.detectRepo('https://github.com/o/r');
      expect(out.suggestedBuildPack).toBe('dockerfile');
      expect(out.detail).toContain('Dockerfile');
    });

    it('404 / dépôt privé ⇒ fallback main + nixpacks, jamais rejeté', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => null });
      const out = await service.detectRepo('https://github.com/private/secret');
      expect(out.valid).toBe(true);
      expect(out.defaultBranch).toBe('main');
      expect(out.suggestedBuildPack).toBe('nixpacks');
      expect(out.repoFullName).toBe('private/secret');
    });

    it('non-GitHub ⇒ défauts (main/nixpacks) sans appel API', async () => {
      const out = await service.detectRepo('https://gitlab.com/foo/bar.git');
      expect(out.valid).toBe(true);
      expect(out.defaultBranch).toBe('main');
      expect(out.suggestedBuildPack).toBe('nixpacks');
      expect(out.repoFullName).toBe('foo/bar');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('erreur réseau GitHub ⇒ fallback (best-effort, jamais rejeté)', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));
      const out = await service.detectRepo('https://github.com/o/r');
      expect(out.valid).toBe(true);
      expect(out.defaultBranch).toBe('main');
      expect(out.suggestedBuildPack).toBe('nixpacks');
    });
  });

  describe('suggestBuildPack()', () => {
    it('dockerfile pour Dockerfile, nixpacks pour les langages et null', () => {
      expect(suggestBuildPack('Dockerfile')).toBe('dockerfile');
      expect(suggestBuildPack('TypeScript')).toBe('nixpacks');
      expect(suggestBuildPack('Python')).toBe('nixpacks');
      expect(suggestBuildPack('PHP')).toBe('nixpacks');
      expect(suggestBuildPack(null)).toBe('nixpacks');
      expect(suggestBuildPack('COBOL')).toBe('nixpacks');
    });
  });
});
