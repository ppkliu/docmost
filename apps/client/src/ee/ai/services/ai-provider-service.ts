import api from "@/lib/api-client.ts";
import {
  AiConfigResponse,
  AiModelsResponse,
  AiSettingsDto,
  AiSettingsResponse,
  AiTestDto,
  AiTestResponse,
} from "@/ee/ai/types/ai.types.ts";

export async function getAiConfig(): Promise<AiConfigResponse> {
  const res = await api.get<AiConfigResponse>("/ai/config");
  return res.data;
}

export async function updateAiProviderSettings(
  dto: AiSettingsDto,
): Promise<AiSettingsResponse> {
  const res = await api.post<AiSettingsResponse>("/ai/settings", dto);
  return res.data;
}

// Tests the draft config (merged over stored + env) without saving it.
export async function testAiProvider(dto: AiTestDto): Promise<AiTestResponse> {
  const res = await api.post<AiTestResponse>("/ai/settings/test", dto);
  return res.data;
}

// Lists models available at the (draft) endpoint for the model pickers.
export async function discoverAiModels(
  dto: AiSettingsDto,
): Promise<AiModelsResponse> {
  const res = await api.post<AiModelsResponse>("/ai/settings/models", dto);
  return res.data;
}
