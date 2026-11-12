import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { ClsService } from 'nestjs-cls';
import { AuditContext, AUDIT_CONTEXT_KEY } from '../middlewares/audit-context.middleware';

@Injectable()
export class AuditActorInterceptor implements NestInterceptor {
  constructor(private readonly cls: ClsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const user = request.user?.user;

    if (user?.id) {
      const auditContext = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
      if (auditContext) {
        auditContext.actorId = user.id;
        applyApiKeyIdentity(auditContext, request?.raw);
        this.cls.set(AUDIT_CONTEXT_KEY, auditContext);
      }
    }

    return next.handle();
  }
}

/**
 * API-key requests are recorded as actorType 'api_key' with the key's id and
 * owner. actorId stays the effective user (the on-behalf-of target when that
 * header was used); impersonatorId is then the key owner who delegated.
 */
export function applyApiKeyIdentity(auditContext: AuditContext, raw: any): void {
  if (raw?.authType !== 'api_key') return;
  auditContext.actorType = 'api_key';
  auditContext.apiKeyId = raw.apiKeyId ?? null;
  auditContext.apiKeyName = raw.apiKeyName ?? null;
  auditContext.apiKeyOwnerId = raw.apiKeyOwnerId ?? null;
  auditContext.impersonatorId = raw.impersonatorId ?? null;
}
