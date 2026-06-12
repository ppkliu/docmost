import { LicenseCheckService } from './license-check.service';
import { Feature } from '../../common/features';

describe('LicenseCheckService (self-hosted OSS unlock)', () => {
  let service: LicenseCheckService;

  beforeEach(() => {
    const moduleRef = {} as any; // EE license module is absent; require() throws -> catch
    const environmentService = { isCloud: () => false } as any;
    service = new LicenseCheckService(moduleRef, environmentService);
  });

  it('grants OSS-implemented features without an EE license', () => {
    expect(service.hasFeature(null, Feature.API_KEYS)).toBe(true);
    expect(service.hasFeature(null, Feature.MCP)).toBe(true);
    expect(service.hasFeature(null, Feature.AI)).toBe(true);
    expect(service.hasFeature(null, Feature.COMMENT_RESOLUTION)).toBe(true);
    expect(service.hasFeature(null, Feature.DOCX_IMPORT)).toBe(true);
    expect(service.hasFeature(null, Feature.AUDIT_LOGS)).toBe(true);
    expect(service.hasFeature(null, Feature.TEMPLATES)).toBe(true);
    expect(service.hasFeature(null, Feature.PAGE_PERMISSIONS)).toBe(true);
  });

  it('still gates EE-only features (scim, security)', () => {
    expect(service.hasFeature(null, Feature.SCIM)).toBe(false);
    expect(service.hasFeature(null, Feature.SECURITY_SETTINGS)).toBe(false);
  });

  it('includes the OSS features in the resolved entitlements', () => {
    const features = service.resolveFeatures(null, 'free');
    expect(features).toEqual(
      expect.arrayContaining([
        Feature.API_KEYS,
        Feature.MCP,
        Feature.AI,
        Feature.COMMENT_RESOLUTION,
        Feature.DOCX_IMPORT,
        Feature.AUDIT_LOGS,
        Feature.TEMPLATES,
        Feature.PAGE_PERMISSIONS,
      ]),
    );
    expect(features).not.toContain(Feature.SCIM);
  });

  it('does not duplicate features', () => {
    const features = service.getFeatures(null);
    expect(new Set(features).size).toBe(features.length);
  });
});
