import { stripWorkspaceSecrets } from '../../../common/helpers/workspace-secrets';

// Applied at every endpoint that serializes a workspace row:
// /users/me, /auth/setup, /workspace/info, /workspace/update.
describe('stripWorkspaceSecrets', () => {
  it('removes the AI provider apiKey before the row leaves the API', () => {
    const workspace = {
      id: 'ws1',
      settings: {
        ai: {
          generative: true,
          provider: {
            driver: 'openai-compatible',
            baseUrl: 'http://llm.local/v1',
            apiKey: 'enc:v1:secret-blob',
            completionModel: 'qwen3-32b',
          },
        },
      },
    };

    const out = stripWorkspaceSecrets(workspace);

    expect((out.settings.ai.provider as any).apiKey).toBeUndefined();
    // everything else survives
    expect(out.settings.ai.provider.baseUrl).toBe('http://llm.local/v1');
    expect(out.settings.ai.provider.completionModel).toBe('qwen3-32b');
    expect(out.settings.ai.generative).toBe(true);
  });

  it('removes knowledge-base connector apiKeys as well', () => {
    const workspace = {
      id: 'ws1',
      settings: {
        ai: {
          knowledgeBases: [
            {
              id: 'kb1',
              type: 'cognee',
              name: 'Team Cognee',
              baseUrl: 'http://kb',
              apiKey: 'enc:v1:blob',
              enabled: true,
            },
            { id: 'kb2', type: 'custom', name: 'NoKey', baseUrl: 'http://x', enabled: true },
          ],
        },
      },
    };

    const out = stripWorkspaceSecrets(workspace);
    expect((out.settings.ai.knowledgeBases[0] as any).apiKey).toBeUndefined();
    expect(out.settings.ai.knowledgeBases[0].name).toBe('Team Cognee');
    expect(out.settings.ai.knowledgeBases[1]).toEqual(
      workspace.settings.ai.knowledgeBases[1],
    );
  });

  it('leaves workspaces without an AI provider config untouched', () => {
    const workspace = { id: 'ws1', settings: { ai: { generative: false } } };
    expect(stripWorkspaceSecrets(workspace)).toEqual(workspace);

    const noSettings = { id: 'ws2', settings: null };
    expect(stripWorkspaceSecrets(noSettings)).toEqual(noSettings);
  });
});
