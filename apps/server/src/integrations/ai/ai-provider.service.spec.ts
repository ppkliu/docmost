import { AiProviderService } from './ai-provider.service';
import { encryptSecret } from './secret.util';

function makeEnv(overrides: Record<string, any> = {}) {
  const env = {
    getAppSecret: () => 'test-app-secret',
    getAiDriver: () => 'openai',
    getOpenAiApiKey: () => 'env-openai-key',
    getOpenAiApiUrl: () => 'https://env.openai/v1',
    getGeminiApiKey: () => 'env-gemini-key',
    getOllamaApiUrl: () => 'http://env-ollama:11434',
    getAiCompletionModel: () => 'env-completion',
    getAiEmbeddingModel: () => 'env-embedding',
    getAiEmbeddingDimension: () => 1536,
    ...overrides,
  };
  return env as any;
}

describe('AiProviderService.resolveConfig', () => {
  it('falls back entirely to env when no workspace override exists', () => {
    const svc = new AiProviderService(makeEnv());
    expect(svc.resolveConfig(null)).toEqual({
      driver: 'openai',
      baseUrl: 'https://env.openai/v1',
      apiKey: 'env-openai-key',
      completionModel: 'env-completion',
      embeddingModel: 'env-embedding',
      embeddingDimension: 1536,
    });
  });

  it('overrides env per field with the workspace provider config', () => {
    const svc = new AiProviderService(makeEnv());
    const cfg = svc.resolveConfig({
      ai: {
        provider: {
          baseUrl: 'https://ws.example/v1',
          apiKey: 'ws-key',
          completionModel: 'ws-model',
        },
      },
    } as any);
    // overridden fields
    expect(cfg.baseUrl).toBe('https://ws.example/v1');
    expect(cfg.apiKey).toBe('ws-key');
    expect(cfg.completionModel).toBe('ws-model');
    // untouched fields still come from env
    expect(cfg.driver).toBe('openai');
    expect(cfg.embeddingModel).toBe('env-embedding');
    expect(cfg.embeddingDimension).toBe(1536);
  });

  it('selects the api key / base url env source by resolved driver', () => {
    const gemini = new AiProviderService(makeEnv()).resolveConfig({
      ai: { provider: { driver: 'gemini' } },
    } as any);
    expect(gemini.apiKey).toBe('env-gemini-key');

    const ollama = new AiProviderService(makeEnv()).resolveConfig({
      ai: { provider: { driver: 'ollama' } },
    } as any);
    expect(ollama.baseUrl).toBe('http://env-ollama:11434');
  });

  it('lowercases the driver', () => {
    const svc = new AiProviderService(makeEnv({ getAiDriver: () => 'OpenAI' }));
    expect(svc.resolveConfig(null).driver).toBe('openai');
  });

  describe('apiKey at rest', () => {
    it('decrypts an encrypted workspace apiKey', () => {
      const svc = new AiProviderService(makeEnv());
      const cfg = svc.resolveConfig({
        ai: {
          provider: {
            apiKey: encryptSecret('sk-stored', 'test-app-secret'),
          },
        },
      } as any);
      expect(cfg.apiKey).toBe('sk-stored');
    });

    it('passes legacy plaintext workspace keys through', () => {
      const svc = new AiProviderService(makeEnv());
      const cfg = svc.resolveConfig({
        ai: { provider: { apiKey: 'sk-legacy-plain' } },
      } as any);
      expect(cfg.apiKey).toBe('sk-legacy-plain');
    });

    it('falls back to env when the key cannot be decrypted', () => {
      const svc = new AiProviderService(makeEnv());
      const cfg = svc.resolveConfig({
        ai: {
          provider: { apiKey: encryptSecret('sk-stored', 'other-secret') },
        },
      } as any);
      // undecryptable workspace key resolves as unset -> env key applies
      expect(cfg.apiKey).toBe('env-openai-key');
    });
  });

  describe('configured checks', () => {
    it('isConfigured needs a driver + completion model', () => {
      const svc = new AiProviderService(makeEnv());
      expect(svc.isConfigured(svc.resolveConfig(null))).toBe(true);

      const noModel = new AiProviderService(
        makeEnv({ getAiCompletionModel: () => '' }),
      );
      expect(noModel.isConfigured(noModel.resolveConfig(null))).toBe(false);
    });

    it('isEmbeddingConfigured needs driver + embedding model + dimension', () => {
      const svc = new AiProviderService(makeEnv());
      expect(svc.isEmbeddingConfigured(svc.resolveConfig(null))).toBe(true);

      const noDim = new AiProviderService(
        makeEnv({ getAiEmbeddingDimension: () => 0 }),
      );
      expect(noDim.isEmbeddingConfigured(noDim.resolveConfig(null))).toBe(false);
    });
  });
});
