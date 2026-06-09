import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql, SqlBool } from 'kysely';
import { KyselyDB, KyselyTransaction } from '../../types/kysely.types';
import { dbOrTx } from '../../utils';
import {
  AiChat,
  AiChatMessage,
  InsertableAiChat,
  InsertableAiChatMessage,
  UpdatableAiChat,
} from '@docmost/db/types/entity.types';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { executeWithCursorPagination } from '@docmost/db/pagination/cursor-pagination';
import { JsonValue } from '@docmost/db/types/db';

/** Serializes a value into a jsonb literal, or SQL NULL when absent. */
function toJsonb(value: unknown) {
  if (value === null || value === undefined) return null;
  return sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
}

/**
 * Insert shape for a message. `toolCalls`/`metadata` are widened to `unknown`
 * because this repo serializes them to jsonb itself (the kysely `Json` type is
 * too strict for arbitrary tool-call payloads).
 */
type InsertChatMessage = Omit<
  InsertableAiChatMessage,
  'toolCalls' | 'metadata'
> & {
  toolCalls?: unknown;
  metadata?: unknown;
};

@Injectable()
export class AiChatRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async insertChat(
    insertable: InsertableAiChat,
    trx?: KyselyTransaction,
  ): Promise<AiChat> {
    const db = dbOrTx(this.db, trx);
    return db
      .insertInto('aiChats')
      .values(insertable)
      .returningAll()
      .executeTakeFirst();
  }

  /** Loads a chat owned by the given creator in the given workspace. */
  async findChatById(
    chatId: string,
    workspaceId: string,
    creatorId: string,
  ): Promise<AiChat | undefined> {
    return this.db
      .selectFrom('aiChats')
      .selectAll('aiChats')
      .where('id', '=', chatId)
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', creatorId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  async findChats(
    workspaceId: string,
    creatorId: string,
    pagination: PaginationOptions,
  ) {
    const query = this.db
      .selectFrom('aiChats')
      .selectAll('aiChats')
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', creatorId)
      .where('deletedAt', 'is', null);

    return executeWithCursorPagination(query, {
      perPage: pagination.limit,
      cursor: pagination.cursor,
      beforeCursor: pagination.beforeCursor,
      // newest first; id is a uuid v7 so it sorts chronologically.
      fields: [{ expression: 'id', direction: 'desc' }],
      parseCursor: (cursor) => ({ id: cursor.id }),
    });
  }

  async updateChat(
    updatable: UpdatableAiChat,
    chatId: string,
    trx?: KyselyTransaction,
  ): Promise<void> {
    const db = dbOrTx(this.db, trx);
    await db
      .updateTable('aiChats')
      .set(updatable)
      .where('id', '=', chatId)
      .execute();
  }

  /** Soft-delete: the cascade FK on messages keeps history until a hard purge. */
  async softDeleteChat(chatId: string): Promise<void> {
    await this.db
      .updateTable('aiChats')
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', chatId)
      .execute();
  }

  /** Title match or full-text match on any message body, newest first. */
  async searchChats(
    workspaceId: string,
    creatorId: string,
    query: string,
    limit = 20,
  ): Promise<AiChat[]> {
    const term = query.trim();
    if (!term) return [];

    return this.db
      .selectFrom('aiChats')
      .selectAll('aiChats')
      .where('workspaceId', '=', workspaceId)
      .where('creatorId', '=', creatorId)
      .where('deletedAt', 'is', null)
      .where((eb) =>
        eb.or([
          eb('title', 'ilike', `%${term}%`),
          eb.exists(
            eb
              .selectFrom('aiChatMessages')
              .select('id')
              .whereRef('aiChatMessages.chatId', '=', 'aiChats.id')
              .where(
                sql<SqlBool>`ai_chat_messages.tsv @@ plainto_tsquery('english', f_unaccent(${term}))`,
              ),
          ),
        ]),
      )
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  async insertMessage(
    insertable: InsertChatMessage,
    trx?: KyselyTransaction,
  ): Promise<AiChatMessage> {
    const db = dbOrTx(this.db, trx);
    const { toolCalls, metadata, ...rest } = insertable;
    const row = await db
      .insertInto('aiChatMessages')
      .values({
        ...rest,
        // Explicit JSON cast: the postgres.js driver would otherwise treat a
        // top-level JS array as a postgres array, not jsonb.
        toolCalls: toJsonb(toolCalls),
        metadata: toJsonb(metadata),
      })
      .returning([
        'id',
        'chatId',
        'workspaceId',
        'userId',
        'role',
        'content',
        'toolCalls',
        'metadata',
        'createdAt',
        'updatedAt',
        'deletedAt',
      ])
      .executeTakeFirst();
    return row as AiChatMessage;
  }

  /** Chronological message history for a chat (excludes the internal tsv column). */
  async findMessages(chatId: string): Promise<AiChatMessage[]> {
    const rows = await this.db
      .selectFrom('aiChatMessages')
      .select([
        'id',
        'chatId',
        'workspaceId',
        'userId',
        'role',
        'content',
        'toolCalls',
        'metadata',
        'createdAt',
        'updatedAt',
        'deletedAt',
      ])
      .where('chatId', '=', chatId)
      .where('deletedAt', 'is', null)
      .orderBy('id', 'asc')
      .execute();
    return rows as AiChatMessage[];
  }
}
