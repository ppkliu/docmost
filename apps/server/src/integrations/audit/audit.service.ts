import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { AuditLogPayload, ActorType } from '../../common/events/audit-events';
import {
  AuditContext,
  AUDIT_CONTEXT_KEY,
} from '../../common/middlewares/audit-context.middleware';
import { ClsService } from 'nestjs-cls';

export type AuditLogContext = {
  workspaceId: string;
  actorId?: string;
  actorType?: ActorType;
  ipAddress?: string;
  userAgent?: string;
};

export type IAuditService = {
  log(payload: AuditLogPayload): void | Promise<void>;
  logWithContext(
    payload: AuditLogPayload,
    context: AuditLogContext,
  ): void | Promise<void>;
  logBatchWithContext(
    payloads: AuditLogPayload[],
    context: AuditLogContext,
  ): void | Promise<void>;
  setActorId(actorId: string): void;
  setActorType(actorType: ActorType): void;
  updateRetention(
    workspaceId: string,
    retentionDays: number,
  ): void | Promise<void>;
};

export const AUDIT_SERVICE = Symbol('AUDIT_SERVICE');

@Injectable()
export class AuditService implements IAuditService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly cls: ClsService,
  ) {}

  async log(payload: AuditLogPayload): Promise<void> {
    const context = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (!context?.workspaceId) return;
    await this.logWithContext(payload, {
      workspaceId: context.workspaceId,
      actorId: context.actorId ?? undefined,
      actorType: context.actorType,
      ipAddress: context.ipAddress ?? undefined,
      userAgent: context.userAgent ?? undefined,
    });
  }

  async logWithContext(
    payload: AuditLogPayload,
    context: AuditLogContext,
  ): Promise<void> {
    await this.db
      .insertInto('audit')
      .values({
        workspaceId: context.workspaceId,
        actorId: context.actorId ?? null,
        actorType: context.actorType ?? 'user',
        event: payload.event,
        resourceType: payload.resourceType,
        resourceId: payload.resourceId ?? null,
        spaceId: payload.spaceId ?? null,
        changes: payload.changes ?? null,
        metadata: {
          ...(payload.metadata ?? {}),
          ...(context.userAgent ? { userAgent: context.userAgent } : {}),
        },
        ipAddress: context.ipAddress ?? null,
      })
      .execute();
  }

  async logBatchWithContext(
    payloads: AuditLogPayload[],
    context: AuditLogContext,
  ): Promise<void> {
    if (payloads.length === 0) return;
    await this.db
      .insertInto('audit')
      .values(
        payloads.map((payload) => ({
          workspaceId: context.workspaceId,
          actorId: context.actorId ?? null,
          actorType: context.actorType ?? 'user',
          event: payload.event,
          resourceType: payload.resourceType,
          resourceId: payload.resourceId ?? null,
          spaceId: payload.spaceId ?? null,
          changes: payload.changes ?? null,
          metadata: {
            ...(payload.metadata ?? {}),
            ...(context.userAgent ? { userAgent: context.userAgent } : {}),
          },
          ipAddress: context.ipAddress ?? null,
        })),
      )
      .execute();
  }

  setActorId(actorId: string): void {
    const context = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (context) {
      this.cls.set(AUDIT_CONTEXT_KEY, { ...context, actorId });
    }
  }

  setActorType(actorType: ActorType): void {
    const context = this.cls.get<AuditContext>(AUDIT_CONTEXT_KEY);
    if (context) {
      this.cls.set(AUDIT_CONTEXT_KEY, { ...context, actorType });
    }
  }

  async updateRetention(
    workspaceId: string,
    retentionDays: number,
  ): Promise<void> {
    await this.db
      .updateTable('workspaces')
      .set({ auditRetentionDays: retentionDays, updatedAt: new Date() })
      .where('id', '=', workspaceId)
      .execute();
  }
}
