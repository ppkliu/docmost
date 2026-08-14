import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EnvironmentService } from './environment.service';

describe('EnvironmentService', () => {
  let service: EnvironmentService;
  let values: Record<string, string>;

  beforeEach(async () => {
    values = { APP_SECRET: 'test-secret', AI_DRIVER: 'openai' };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnvironmentService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: string) => values[key] ?? fallback,
          },
        },
      ],
    }).compile();

    service = module.get<EnvironmentService>(EnvironmentService);
  });

  it('reads config values through the ConfigService', () => {
    expect(service.getAppSecret()).toBe('test-secret');
    expect(service.getAiDriver()).toBe('openai');
  });

  describe('getNativeLoginZone', () => {
    it('defaults native login to office', () => {
      expect(service.getNativeLoginZone()).toBe('office');
    });

    it('can configure native login as internal for test deployments', () => {
      values.DOCMOST_NATIVE_LOGIN_ZONE = 'internal';

      expect(service.getNativeLoginZone()).toBe('internal');
    });

    it('falls back to office for invalid native login zone values', () => {
      values.DOCMOST_NATIVE_LOGIN_ZONE = 'bogus';

      expect(service.getNativeLoginZone()).toBe('office');
    });
  });

  describe('getFileUploadSizeLimit', () => {
    /**
     * The wiki cap and the knowledge-base cap must be able to line up. A file
     * that uploads to the wiki but never reaches the knowledge base is a silent
     * gap: it looks fine in the UI and only the admin console shows why.
     */
    it('defaults to 200mb so large attachments are not rejected at the door', () => {
      expect(service.getFileUploadSizeLimit()).toBe('200mb');
    });

    it('is configurable for deployments with less headroom', () => {
      values.FILE_UPLOAD_SIZE_LIMIT = '50mb';

      expect(service.getFileUploadSizeLimit()).toBe('50mb');
    });

    /**
     * `FILE_UPLOAD_SIZE_LIMIT=` (present but empty) must not parse to a 0-byte
     * limit — that would reject every upload with no obvious cause.
     */
    it('treats an empty value as unset', () => {
      values.FILE_UPLOAD_SIZE_LIMIT = '';

      expect(service.getFileUploadSizeLimit()).toBe('200mb');
    });

    it('keeps the import limit aligned with the upload limit', () => {
      expect(service.getFileImportSizeLimit()).toBe('200mb');
    });
  });

  describe('getLoginNetworkZone', () => {
    it('keeps an adjustable parameterized hook for controlled callers', () => {
      expect(
        service.getLoginNetworkZone('native', { overrideZone: 'office' }),
      ).toBe('office');

      expect(service.getLoginNetworkZone('native')).toBe('office');
    });
  });
});
