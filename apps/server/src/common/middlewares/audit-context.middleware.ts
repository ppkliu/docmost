import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ClsService } from 'nestjs-cls';

export interface AuditContext {
  workspaceId: string | null;
  actorId: string | null;
  actorType: 'user' | 'system' | 'api_key';
  ipAddress: string | null;
  userAgent: string | null;
  // Source chain claimed by the proxy in front (see forwardedForOf). ipAddress
  // is only as good as the proxies' trust settings, so keep the claim too.
  // Unverified: for investigation only, never for access decisions.
  forwardedFor?: string | null;
  // The end user's address: leftmost entry of the claimed chain, else ipAddress.
  // ipAddress stays the proxy's (WUJI) address, which the zone logic relies on.
  clientIp?: string | null;
  // Set by AuditActorInterceptor for API-key requests (see jwt.strategy.ts)
  apiKeyId?: string | null;
  apiKeyName?: string | null;
  apiKeyOwnerId?: string | null;
  impersonatorId?: string | null;
}

export const AUDIT_CONTEXT_KEY = 'auditContext';

@Injectable()
export class AuditContextMiddleware implements NestMiddleware {
  constructor(private readonly cls: ClsService) {}

  use(req: FastifyRequest['raw'], res: FastifyReply['raw'], next: () => void) {
    const workspaceId = (req as any).workspaceId ?? null;

    const ipAddress = (req as any).ip ?? (req as any).socket?.remoteAddress ?? null;

    const userAgent =
      (req.headers['user-agent'] as string) ?? null;

    const forwardedFor = forwardedForOf(req.headers);
    const clientIp = clientIpOf(req.headers, ipAddress);

    const auditContext: AuditContext = {
      workspaceId,
      actorId: null,
      actorType: 'user',
      ipAddress,
      userAgent,
      forwardedFor,
      clientIp,
    };

    this.cls.set(AUDIT_CONTEXT_KEY, auditContext);

    next();
  }
}

/**
 * The edge Caddy replaces X-Forwarded-For sent by an untrusted peer (e.g. the
 * WUJI proxy) and passes the original chain as X-Forwarded-For-Claimed; prefer
 * that, fall back to X-Forwarded-For when Docmost is reached without that Caddy.
 */
export function forwardedForOf(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  return (
    headerValue(headers['x-forwarded-for-claimed']) ??
    headerValue(headers['x-forwarded-for'])
  );
}

const IP_LIKE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The end user's IP: the leftmost address in X-Forwarded-For-Claimed (what the
 * WUJI proxy says its client was), falling back to the connecting address when
 * the request did not come through that proxy. Unverified, like the chain itself.
 */
export function clientIpOf(
  headers: Record<string, string | string[] | undefined>,
  ipAddress: string | null,
): string | null {
  const claimed = headerValue(headers['x-forwarded-for-claimed']);
  const first = claimed?.split(',')[0]?.trim();
  if (first && IP_LIKE.test(first)) return first;
  return ipAddress ? String(ipAddress).slice(0, 64) : null;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value == null) return null;
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return text ? text.slice(0, 500) : null;
}
