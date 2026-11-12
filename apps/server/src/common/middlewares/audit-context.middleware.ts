import { Injectable, NestMiddleware } from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { ClsService } from 'nestjs-cls';

export interface AuditContext {
  workspaceId: string | null;
  actorId: string | null;
  actorType: 'user' | 'system' | 'api_key';
  ipAddress: string | null;
  userAgent: string | null;
  // Raw X-Forwarded-For chain: ipAddress is only as good as the proxies'
  // trust settings, so keep what they claimed for later investigation.
  forwardedFor?: string | null;
  // Set by AuditActorInterceptor for API-key requests (see jwt.strategy.ts)
  apiKeyId?: string | null;
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

    const forwardedFor = headerValue(req.headers['x-forwarded-for']);

    const auditContext: AuditContext = {
      workspaceId,
      actorId: null,
      actorType: 'user',
      ipAddress,
      userAgent,
      forwardedFor,
    };

    this.cls.set(AUDIT_CONTEXT_KEY, auditContext);

    next();
  }
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value == null) return null;
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return text ? text.slice(0, 500) : null;
}
