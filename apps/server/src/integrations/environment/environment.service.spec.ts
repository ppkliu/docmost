import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EnvironmentService } from './environment.service';

describe('EnvironmentService', () => {
  let service: EnvironmentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnvironmentService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: string) =>
              ({ APP_SECRET: 'test-secret', AI_DRIVER: 'openai' })[key] ??
              fallback,
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
});
