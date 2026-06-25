import { NetworkOriginService } from './network-origin.service';

function makeService(overrides: Partial<any> = {}) {
  const env = {
    getInternalCidrs: jest.fn().mockReturnValue(['100.0.0.0/8']),
    getOriginNetworkMaskV4: jest.fn().mockReturnValue(24),
    getOriginNetworkMaskV6: jest.fn().mockReturnValue(64),
    getUnknownOriginPolicy: jest.fn().mockReturnValue('allow'),
    getTrustProxy: jest.fn().mockReturnValue(false),
    ...overrides,
  };

  return {
    env,
    service: new NetworkOriginService(env as any),
  };
}

function req(ip: string, headers: Record<string, string> = {}) {
  return { ip, headers } as any;
}

describe('NetworkOriginService', () => {
  it('marks requests from the 100 network as internal', () => {
    const { service } = makeService();

    expect(service.getRequestOrigin(req('100.12.1.5'))).toMatchObject({
      originIp: '100.12.1.5',
      originNetwork: '100.12.1.0/24',
      originNetworkScope: 'internal',
    });
  });

  it('allows internal requests regardless of resource origin network', () => {
    const { service } = makeService();

    expect(service.isAllowed('172.20.8.0/24', req('100.1.2.3'))).toBe(true);
  });

  it('allows external requests from the same origin network', () => {
    const { service } = makeService();

    expect(service.isAllowed('172.20.8.0/24', req('172.20.8.44'))).toBe(true);
  });

  it('rejects external requests from a different origin network', () => {
    const { service } = makeService();

    expect(service.isAllowed('172.20.8.0/24', req('172.20.9.44'))).toBe(false);
  });

  it('uses the configured unknown-origin policy', () => {
    const { service: allowService } = makeService({
      getUnknownOriginPolicy: jest.fn().mockReturnValue('allow'),
    });
    const { service: denyService } = makeService({
      getUnknownOriginPolicy: jest.fn().mockReturnValue('deny'),
    });

    expect(allowService.isAllowed(null, req('172.20.9.44'))).toBe(true);
    expect(denyService.isAllowed(null, req('172.20.9.44'))).toBe(false);
  });

  it('only trusts forwarded headers when trust proxy is enabled', () => {
    const { service: untrusted } = makeService({
      getTrustProxy: jest.fn().mockReturnValue(false),
    });
    const { service: trusted } = makeService({
      getTrustProxy: jest.fn().mockReturnValue(true),
    });
    const forwarded = req('10.0.0.10', {
      'x-forwarded-for': '172.20.8.44, 10.0.0.10',
    });

    expect(untrusted.getRequestOrigin(forwarded).originNetwork).toBe(
      '10.0.0.0/24',
    );
    expect(trusted.getRequestOrigin(forwarded).originNetwork).toBe(
      '172.20.8.0/24',
    );
  });
});
