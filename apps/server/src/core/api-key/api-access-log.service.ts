import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

export type ApiAccessEntry = {
  workspaceId: string | null;
  apiKeyId: string | null;
  keyOwnerId: string | null;
  userId: string | null;
  impersonatorId: string | null;
  onBehalfOf: string | null;
  method: string;
  path: string;
  statusCode: number | null;
  durationMs: number | null;
  ipAddress: string | null;
  forwardedFor: string | null;
  userAgent: string | null;
  requestSummary: Record<string, unknown> | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Body fields worth keeping: ids say *what* was touched, role/name say *how*.
const KEEP_EXACT = new Set(['role', 'name', 'slug', 'title', 'email', 'emails', 'type', 'format']);
const KEEP_SUFFIX = /(Id|Ids)$/;
// Never stored, even when the name looks like an id field.
const SECRET = /token|secret|password|passwd|content|ydoc|cookie|authorization|^key$/i;
const MAX_KEYS = 30;
const MAX_ARRAY = 100;
const MAX_STRING = 200;

const clip = (v: string, n: number) => (v.length > n ? v.slice(0, n) : v);
const uuidOrNull = (v: unknown) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

/** Ids and roles from a JSON body; null for anything that is not a plain object. */
export function summarizeRequestBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) return null;
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (kept >= MAX_KEYS) break;
    if (SECRET.test(key) || !(KEEP_EXACT.has(key) || KEEP_SUFFIX.test(key))) continue;
    if (typeof value === 'string') out[key] = clip(value, MAX_STRING);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) {
      const items = value
        .filter((v) => ['string', 'number', 'boolean'].includes(typeof v))
        .slice(0, MAX_ARRAY)
        .map((v) => (typeof v === 'string' ? clip(v, MAX_STRING) : v));
      out[key] = items;
      if (value.length > MAX_ARRAY) out[`${key}Count`] = value.length;
    } else continue;
    kept += 1;
  }
  return Object.keys(out).length ? out : null;
}

const headerText = (v: unknown, n = 500): string | null => {
  if (v == null) return null;
  const text = Array.isArray(v) ? v.join(', ') : String(v);
  return text ? clip(text, n) : null;
};

/**
 * Builds the row for an API-key request, or null for any other request
 * (browser sessions are covered by the audit table). Reads what
 * jwt.strategy.ts left on request.raw; runs in Fastify's onResponse hook.
 */
export function buildApiAccessEntry(request: any, reply: any): ApiAccessEntry | null {
  const raw = request?.raw ?? {};
  if (raw.authType !== 'api_key') return null;
  const url = String(request.url ?? raw.url ?? '');
  const elapsed = Number(reply?.elapsedTime);
  return {
    workspaceId: uuidOrNull(raw.workspaceId),
    apiKeyId: uuidOrNull(raw.apiKeyId),
    keyOwnerId: uuidOrNull(raw.apiKeyOwnerId),
    userId: uuidOrNull(request.user?.user?.id),
    impersonatorId: uuidOrNull(raw.impersonatorId),
    onBehalfOf: raw.onBehalfOf ? clip(String(raw.onBehalfOf), 320) : null,
    method: String(request.method ?? raw.method ?? '').toUpperCase(),
    // query strings can carry tokens; the path alone says which endpoint
    path: clip(url.split('?')[0], 500),
    statusCode: Number.isFinite(reply?.statusCode) ? reply.statusCode : null,
    durationMs: Number.isFinite(elapsed) ? Math.round(elapsed) : null,
    ipAddress: request.ip ? clip(String(request.ip), 100) : null,
    forwardedFor: headerText(request.headers?.['x-forwarded-for']),
    userAgent: headerText(request.headers?.['user-agent']),
    requestSummary: summarizeRequestBody(request.body),
  };
}

@Injectable()
export class ApiAccessLogService {
  private readonly logger = new Logger('ApiAccessLog');

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  /** Best effort: a failed insert is logged and never fails the request. */
  async record(entry: ApiAccessEntry): Promise<void> {
    try {
      await this.db
        .insertInto('apiAccessLog')
        .values((eb) => ({
          workspaceId: entry.workspaceId,
          apiKeyId: entry.apiKeyId,
          apiKeyName: entry.apiKeyId
            ? eb.selectFrom('apiKeys').select('name').where('id', '=', entry.apiKeyId)
            : null,
          keyOwnerId: entry.keyOwnerId,
          userId: entry.userId,
          impersonatorId: entry.impersonatorId,
          onBehalfOf: entry.onBehalfOf,
          method: entry.method,
          path: entry.path,
          statusCode: entry.statusCode,
          durationMs: entry.durationMs,
          ipAddress: entry.ipAddress,
          forwardedFor: entry.forwardedFor,
          userAgent: entry.userAgent,
          requestSummary: entry.requestSummary ? JSON.stringify(entry.requestSummary) : null,
        }))
        .execute();
    } catch (err: any) {
      this.logger.warn(`api_access_log insert failed: ${err?.message ?? err}`);
    }
  }
}
