import api from "@/lib/api-client.ts";
import {
  KbListResponse,
  KbTestResponse,
  UpsertKbConnectorDto,
} from "@/ee/ai/types/ai.types.ts";

export async function getKbConnectors(): Promise<KbListResponse> {
  const res = await api.get<KbListResponse>("/ai/kb");
  return res.data;
}

export async function upsertKbConnector(
  dto: UpsertKbConnectorDto,
): Promise<KbListResponse> {
  const res = await api.post<KbListResponse>("/ai/kb", dto);
  return res.data;
}

export async function deleteKbConnector(id: string): Promise<KbListResponse> {
  const res = await api.post<KbListResponse>("/ai/kb/delete", { id });
  return res.data;
}

// Tests a stored connector (id) or a draft (type+baseUrl[+apiKey]).
export async function testKbConnector(dto: {
  id?: string;
  type?: string;
  baseUrl?: string;
  apiKey?: string;
  searchPath?: string;
}): Promise<KbTestResponse> {
  const res = await api.post<KbTestResponse>("/ai/kb/test", dto);
  return res.data;
}
