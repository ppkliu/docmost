import { Kysely, sql } from 'kysely';

// One row per request authenticated with an API key, reads included. The audit
// table only covers writes and does not say which key made them; this answers
// "which key, whose key, from where, did what" for automated callers.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('api_access_log')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_uuid_v7()`),
    )
    .addColumn('workspace_id', 'uuid', (col) =>
      col.references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('api_key_id', 'uuid')
    // copied at write time so the row stays readable after the key is renamed
    .addColumn('api_key_name', 'varchar')
    .addColumn('key_owner_id', 'uuid')
    // effective identity: the on-behalf-of target when that header was used
    .addColumn('user_id', 'uuid')
    .addColumn('impersonator_id', 'uuid')
    .addColumn('on_behalf_of', 'varchar')
    .addColumn('method', 'varchar', (col) => col.notNull())
    .addColumn('path', 'varchar', (col) => col.notNull())
    .addColumn('status_code', 'integer')
    .addColumn('duration_ms', 'integer')
    // varchar, not inet: a malformed value must not cost the row
    .addColumn('ip_address', 'varchar')
    .addColumn('forwarded_for', 'varchar')
    .addColumn('user_agent', 'varchar')
    // ids and roles from the body only; never content or secrets
    .addColumn('request_summary', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex('idx_api_access_log_workspace_created')
    .ifNotExists()
    .on('api_access_log')
    .columns(['workspace_id', 'created_at desc'])
    .execute();

  await db.schema
    .createIndex('idx_api_access_log_key_created')
    .ifNotExists()
    .on('api_access_log')
    .columns(['api_key_id', 'created_at desc'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('api_access_log').ifExists().execute();
}
