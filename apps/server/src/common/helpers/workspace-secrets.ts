/**
 * Removes secrets from a workspace row before it leaves the API. AI secrets
 * live in settings.ai (provider.apiKey, knowledgeBases[].apiKey) and must
 * never reach the client (only `hasApiKey` via the /ai endpoints) — applies
 * to every endpoint that serializes a workspace row: /users/me,
 * /workspace/info, /workspace/update, /auth/setup.
 */
export function stripWorkspaceSecrets<T extends { settings?: any }>(
  workspace: T,
): T {
  const ai = workspace?.settings?.ai;
  if (!ai || typeof ai !== 'object') return workspace;

  let nextAi = ai;

  const provider = ai.provider;
  if (provider && typeof provider === 'object' && 'apiKey' in provider) {
    const { apiKey: _apiKey, ...rest } = provider;
    nextAi = { ...nextAi, provider: rest };
  }

  const kbs = ai.knowledgeBases;
  if (Array.isArray(kbs) && kbs.some((kb) => kb && 'apiKey' in kb)) {
    nextAi = {
      ...nextAi,
      knowledgeBases: kbs.map((kb) => {
        if (kb && typeof kb === 'object' && 'apiKey' in kb) {
          const { apiKey: _key, ...rest } = kb;
          return rest;
        }
        return kb;
      }),
    };
  }

  if (nextAi !== ai) {
    workspace.settings = { ...workspace.settings, ai: nextAi };
  }
  return workspace;
}
