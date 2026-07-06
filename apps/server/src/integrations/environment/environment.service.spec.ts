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

    it('keeps native login office even when the configured WUJI host is internal', () => {
      values.DOCMOST_INTERNAL_CIDRS = '10.7.0.0/16';
      values.DOCMOST_OFFICE_CIDRS = '10.124.0.0/16';
      values.DOCMOST_WUJI_HOST = '10.7.11.216';

      expect(service.getNativeLoginZone()).toBe('office');
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
