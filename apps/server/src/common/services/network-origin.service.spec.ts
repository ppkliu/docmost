import { NetworkOriginService } from './network-origin.service';

function makeService(overrides: Partial<any> = {}) {
  const env = {
    getInternalCidrs: jest.fn().mockReturnValue(['100.0.0.0/8']),
    getOfficeCidrs: jest.fn().mockReturnValue(['172.20.0.0/16']),
    getOriginNetworkMaskV4: jest.fn().mockReturnValue(24),
    getOriginNetworkMaskV6: jest.fn().mockReturnValue(64),
    getUnknownOriginPolicy: jest.fn().mockReturnValue('allow'),
    getTrustProxy: jest.fn().mockReturnValue(false),
    getEntranceHeaderRequired: jest.fn().mockReturnValue(false),
    getDeploymentZone: jest.fn().mockReturnValue(null),
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
  describe('getRequestOrigin', () => {
    it('marks requests from the internal CIDR as internal scope', () => {
      const { service } = makeService();

      expect(service.getRequestOrigin(req('100.12.1.5'))).toMatchObject({
        originIp: '100.12.1.5',
        originNetwork: '100.12.1.0/24',
        originNetworkScope: 'internal',
      });
    });

    it('marks requests from the office CIDR as external scope', () => {
      const { service } = makeService();

      expect(service.getRequestOrigin(req('172.20.8.44'))).toMatchObject({
        originIp: '172.20.8.44',
        originNetwork: '172.20.8.0/24',
        originNetworkScope: 'external',
      });
    });

    it('marks requests outside all configured CIDRs as unknown scope', () => {
      const { service } = makeService();

      expect(service.getRequestOrigin(req('8.8.8.8'))).toMatchObject({
        originNetworkScope: 'unknown',
      });
    });
  });

  describe('getRequestZone', () => {
    it('resolves internal, office, and unknown zones from client IP', () => {
      const { service } = makeService();

      expect(service.getRequestZone(req('100.1.2.3'))).toBe('internal');
      expect(service.getRequestZone(req('172.20.8.44'))).toBe('office');
      expect(service.getRequestZone(req('8.8.8.8'))).toBe('unknown');
    });
  });

  describe('getCurrentUserNetworkZone', () => {
    it('is the dedicated current-user network-zone interface', () => {
      const { service } = makeService();

      expect(service.getCurrentUserNetworkZone(req('100.1.2.3'))).toBe(
        'internal',
      );
      expect(service.isCurrentUserInternal(req('100.1.2.3'))).toBe(true);
      expect(service.isCurrentUserOffice(req('172.20.8.44'))).toBe(true);
    });
  });

  describe('isAllowed (zone-based policy)', () => {
    it('always allows internal-zone requesters, regardless of resource scope', () => {
      const { service } = makeService();

      expect(service.isAllowed('internal', req('100.1.2.3'))).toBe(true);
      expect(service.isAllowed('external', req('100.1.2.3'))).toBe(true);
      expect(service.isAllowed('mrdoc', req('100.1.2.3'))).toBe(true);
      expect(service.isAllowed(null, req('100.1.2.3'))).toBe(true);
    });

    it('rejects unknown-zone requesters outright', () => {
      const { service } = makeService();

      expect(service.isAllowed('external', req('8.8.8.8'))).toBe(false);
      expect(service.isAllowed(null, req('8.8.8.8'))).toBe(false);
    });

    it('allows office-zone requesters to reach office-uploaded (external) resources', () => {
      const { service } = makeService();

      expect(service.isAllowed('external', req('172.20.9.44'))).toBe(true);
    });

    it('rejects office-zone requesters from internal-scoped resources', () => {
      const { service } = makeService();

      expect(service.isAllowed('internal', req('172.20.9.44'))).toBe(false);
    });

    it('treats mrdoc-scoped legacy resources as internal-only', () => {
      const { service } = makeService();

      expect(service.isAllowed('mrdoc', req('172.20.9.44'))).toBe(false);
    });

    it('uses the configured unknown-origin policy for office-zone requesters against unscoped resources', () => {
      const { service: allowService } = makeService({
        getUnknownOriginPolicy: jest.fn().mockReturnValue('allow'),
      });
      const { service: denyService } = makeService({
        getUnknownOriginPolicy: jest.fn().mockReturnValue('deny'),
      });

      expect(allowService.isAllowed(null, req('172.20.9.44'))).toBe(true);
      expect(denyService.isAllowed(null, req('172.20.9.44'))).toBe(false);
    });
  });

  describe('hybrid entrance header + CIDR resolution (Phase 8 / G1)', () => {
    it('trusts the CIDR zone when no entrance header is present and it is not required', () => {
      const { service } = makeService();

      expect(service.getRequestZone(req('100.1.2.3'))).toBe('internal');
      expect(service.getRequestZone(req('172.20.8.44'))).toBe('office');
    });

    it('treats a missing header as unknown zone when the header is required', () => {
      const { service } = makeService({
        getEntranceHeaderRequired: jest.fn().mockReturnValue(true),
      });

      expect(service.getRequestZone(req('100.1.2.3'))).toBe('unknown');
    });

    it('agrees when the header matches the CIDR-derived zone', () => {
      const { service } = makeService();

      expect(
        service.getRequestZone(
          req('100.1.2.3', { 'x-docmost-entrance': 'internal' }),
        ),
      ).toBe('internal');
      expect(
        service.getRequestZone(
          req('172.20.8.44', { 'x-docmost-entrance': 'office' }),
        ),
      ).toBe('office');
    });

    it('downgrades to the stricter zone on header/CIDR mismatch (cannot escalate via header)', () => {
      const { service } = makeService();

      // Internal IP claiming the office entrance -> office wins (stricter).
      expect(
        service.getRequestZone(
          req('100.1.2.3', { 'x-docmost-entrance': 'office' }),
        ),
      ).toBe('office');

      // Office IP claiming the internal entrance -> office still wins (stricter).
      expect(
        service.getRequestZone(
          req('172.20.8.44', { 'x-docmost-entrance': 'internal' }),
        ),
      ).toBe('office');
    });

    it('ignores an invalid header value and falls back to the CIDR zone', () => {
      const { service } = makeService();

      expect(
        service.getRequestZone(
          req('100.1.2.3', { 'x-docmost-entrance': 'bogus' }),
        ),
      ).toBe('internal');
    });
  });

  describe('trust proxy behavior', () => {
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
      expect(untrusted.getRequestOrigin(forwarded).originNetworkScope).toBe(
        'unknown',
      );
      expect(trusted.getRequestOrigin(forwarded).originNetworkScope).toBe(
        'external',
      );
    });
  });
});
