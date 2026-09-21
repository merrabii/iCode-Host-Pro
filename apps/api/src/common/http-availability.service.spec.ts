import { HttpAvailabilityService } from './http-availability.service';

// Tests déterministes (aucun réseau réel) : global.fetch est mocké.
// Preuve 17B.3A — comportement identique à l'ancien ProvisioningService.isServed.
describe('HttpAvailabilityService — preuve HTTP (17B.3A)', () => {
  let service: HttpAvailabilityService;
  let fetchMock: jest.Mock;

  const resp = (status: number) => ({ status }) as unknown as Response;

  beforeEach(() => {
    service = new HttpAvailabilityService();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    fetchMock.mockReset();
  });

  it('1. FQDN servi (HTTP 200) ⇒ true, HEAD https://<fqdn> avec redirects suivis', async () => {
    fetchMock.mockResolvedValue(resp(200));

    await expect(service.isServed('app.example.com')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.example.com',
      expect.objectContaining({ method: 'HEAD', redirect: 'follow', signal: expect.any(AbortSignal) }),
    );
  });

  it('2. HTTP 301/302 (redirections, ancienne acceptation 2xx/3xx) ⇒ true', async () => {
    fetchMock.mockResolvedValue(resp(301));
    await expect(service.isServed('app.example.com')).resolves.toBe(true);
    fetchMock.mockResolvedValue(resp(302));
    await expect(service.isServed('app.example.com')).resolves.toBe(true);
  });

  it('3. HTTP 4xx/5xx ⇒ false', async () => {
    for (const code of [400, 404, 500, 503]) {
      fetchMock.mockResolvedValue(resp(code));
      await expect(service.isServed('app.example.com')).resolves.toBe(false);
    }
  });

  it('4a. AbortError ⇒ false (timeout signal aborté)', async () => {
    const state: { signal?: AbortSignal } = {};
    fetchMock.mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      state.signal = init.signal;
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });

    await expect(service.isServed('app.example.com')).resolves.toBe(false);
    expect(state.signal?.aborted).toBe(true);
  });

  it('4b. timeout réel ⇒ abort après timeoutMs, fetch rejette ⇒ false, timer nettoyé', async () => {
    jest.useFakeTimers();
    const state: { signal?: AbortSignal } = {};
    fetchMock.mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      state.signal = init.signal;
      return new Promise((_resolve, reject) => {
        state.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    });

    const pending = service.isServed('app.example.com', 8000);
    await jest.advanceTimersByTimeAsync(8000);
    await expect(pending).resolves.toBe(false);
    expect(state.signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('5. erreur DNS/réseau (TypeError) ⇒ false', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(service.isServed('app.example.com')).resolves.toBe(false);
  });

  it('6. FQDN vide ou invalide ⇒ false SANS requête', async () => {
    for (const bad of ['', '   ', 'bad host', 'https://exemple.com', 'http://x:80/a', 'a/b', 'a b']) {
      await expect(service.isServed(bad)).resolves.toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('7. réponse rapide ⇒ timer/AbortController nettoyés (aucun timer résiduel)', async () => {
    jest.useFakeTimers();
    fetchMock.mockResolvedValue(resp(204));

    await service.isServed('app.example.com');
    expect(jest.getTimerCount()).toBe(0);
  });
});