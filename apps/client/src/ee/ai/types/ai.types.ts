export enum AiAction {
  IMPROVE_WRITING = "improve_writing",
  FIX_SPELLING_GRAMMAR = "fix_spelling_grammar",
  MAKE_SHORTER = "make_shorter",
  MAKE_LONGER = "make_longer",
  SIMPLIFY = "simplify",
  CHANGE_TONE = "change_tone",
  SUMMARIZE = "summarize",
  EXPLAIN = "explain",
  CONTINUE_WRITING = "continue_writing",
  TRANSLATE = "translate",
  CUSTOM = "custom",
}

export interface AiGenerateDto {
  action?: AiAction;
  content: string;
  prompt?: string;
}

export interface AiContentResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AiProviderConfig {
  driver: string;
  baseUrl: string;
  completionModel: string;
  embeddingModel: string;
  embeddingDimension: number;
  hasApiKey: boolean;
  embeddingConfigured: boolean;
}

export interface AiConfigResponse {
  configured: boolean;
  availableActions: AiAction[];
  provider?: AiProviderConfig;
}

export interface AiSettingsDto {
  driver?: string;
  baseUrl?: string;
  apiKey?: string;
  completionModel?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  // Deletes the stored apiKey override (falls back to env).
  clearApiKey?: boolean;
}

export interface AiSettingsResponse {
  configured: boolean;
  provider: AiProviderConfig;
}

export type AiTestTarget = "completion" | "embedding";

export interface AiTestDto extends AiSettingsDto {
  targets?: AiTestTarget[];
}

export interface AiTestResult {
  target: AiTestTarget;
  success: boolean;
  message: string;
  latencyMs: number;
}

export interface AiTestResponse {
  success: boolean;
  results: AiTestResult[];
}

export interface AiModelsResponse {
  models: string[];
  // Set when listing only succeeded after appending /v1 — a suggestion to apply.
  normalizedBaseUrl?: string;
}

// --- External knowledge-base connectors (K1/K2) ---

export type KbType = "cognee" | "llm-wiki" | "custom";

export interface KbConnector {
  id: string;
  type: KbType;
  name: string;
  baseUrl: string;
  searchPath?: string;
  enabled: boolean;
  // K3: mirror docmost content into this KB (cognee only)
  sync?: boolean;
  hasApiKey: boolean;
}

export interface KbListResponse {
  connectors: KbConnector[];
}

export interface UpsertKbConnectorDto {
  id?: string;
  type: KbType;
  name: string;
  baseUrl: string;
  apiKey?: string;
  clearApiKey?: boolean;
  searchPath?: string;
  enabled?: boolean;
  sync?: boolean;
}

export interface KbTestResponse {
  success: boolean;
  message: string;
  latencyMs: number;
}

export interface AiStreamChunk {
  content: string;
}

export interface AiStreamError {
  error: string;
}
