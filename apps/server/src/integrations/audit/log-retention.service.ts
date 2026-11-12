import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { EnvironmentService } from '../environment/environment.service';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
// Small batches keep each DELETE short (audit has no created_at index) and the
// per-run cap bounds how long one sweep can hold the database busy; whatever is
// left over goes in the next daily run.
export const PURGE_BATCH_SIZE = 5000;
export const PURGE_MAX_BATCHES = 200;

export function retentionCutoff(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Deletes in batches until a batch comes back short or the cap is reached.
 * `deleteBatch` removes at most `batchSize` rows and returns how many it removed.
 */
export async function purgeInBatches(
  deleteBatch: (batchSize: number) => Promise<number>,
  { batchSize = PURGE_BATCH_SIZE, maxBatches = PURGE_MAX_BATCHES } = {},
): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const n = await deleteBatch(batchSize);
    deleted += n;
    if (n < batchSize) return { deleted, complete: true };
  }
  return { deleted, complete: false };
}

/**
 * Daily retention sweep for the audit log (per workspace, by the audit
 * retention setting the admin UI already exposes but nothing enforced) and for
 * api_access_log (API_ACCESS_LOG_RETENTION_DAYS, default 180).
 */
@Injectable()
export class LogRetentionService {
  private readonly logger = new Logger(LogRetentionService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
  ) {}

  @Interval('log-retention', DAY_MS)
  async runScheduled(): Promise<void> {
    try {
      await this.purgeAll();
    } catch (err) {
      this.logger.error('Log retention sweep failed', err);
    }
  }

  async purgeAll(now: Date = new Date()): Promise<{ audit: number; apiAccessLog: number }> {
    const audit = await this.purgeAudit(now);
    const apiAccessLog = await this.purgeApiAccessLog(now);
    if (audit || apiAccessLog) {
      this.logger.log(`Log retention: removed ${audit} audit and ${apiAccessLog} api_access_log rows`);
    }
    return { audit, apiAccessLog };
  }

  private async purgeAudit(now: Date): Promise<number> {
    const workspaces = await this.db
      .selectFrom('workspaces')
      .select(['id', 'auditRetentionDays'])
      .execute();
    let total = 0;
    for (const ws of workspaces) {
      const days = Number(ws.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS);
      if (!Number.isFinite(days) || days < 1) continue;
      const cutoff = retentionCutoff(days, now);
      const { deleted, complete } = await purgeInBatches((size) =>
        this.deleteBatch('audit', cutoff, size, ws.id),
      );
      total += deleted;
      if (!complete) this.logger.warn(`audit purge for workspace ${ws.id} hit the per-run cap; continuing tomorrow`);
    }
    return total;
  }

  private async purgeApiAccessLog(now: Date): Promise<number> {
    const days = this.environmentService.getApiAccessLogRetentionDays();
    if (days === 0) return 0;
    const cutoff = retentionCutoff(days, now);
    // rows of rejected keys can lack a workspace, so this one is table-wide
    const { deleted, complete } = await purgeInBatches((size) =>
      this.deleteBatch('api_access_log', cutoff, size, null),
    );
    if (!complete) this.logger.warn('api_access_log purge hit the per-run cap; continuing tomorrow');
    return deleted;
  }

  private async deleteBatch(
    table: 'audit' | 'api_access_log',
    cutoff: Date,
    batchSize: number,
    workspaceId: string | null,
  ): Promise<number> {
    const scope = workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``;
    const result = await sql`
      DELETE FROM ${sql.table(table)}
       WHERE ctid IN (
         SELECT ctid FROM ${sql.table(table)}
          WHERE created_at < ${cutoff} ${scope}
          LIMIT ${batchSize}
       )`.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }
}
