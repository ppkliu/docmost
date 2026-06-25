import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('pages')
    .addColumn('origin_ip', sql`inet`)
    .addColumn('origin_network', sql`cidr`)
    .addColumn('origin_network_scope', 'varchar')
    .addColumn('origin_recorded_at', 'timestamptz')
    .execute();

  await db.schema
    .alterTable('attachments')
    .addColumn('origin_ip', sql`inet`)
    .addColumn('origin_network', sql`cidr`)
    .addColumn('origin_network_scope', 'varchar')
    .addColumn('origin_recorded_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('attachments')
    .dropColumn('origin_recorded_at')
    .dropColumn('origin_network_scope')
    .dropColumn('origin_network')
    .dropColumn('origin_ip')
    .execute();

  await db.schema
    .alterTable('pages')
    .dropColumn('origin_recorded_at')
    .dropColumn('origin_network_scope')
    .dropColumn('origin_network')
    .dropColumn('origin_ip')
    .execute();
}
