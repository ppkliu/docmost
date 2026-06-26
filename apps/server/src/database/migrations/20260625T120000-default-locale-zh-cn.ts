import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE users ALTER COLUMN locale SET DEFAULT 'zh-CN'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE users ALTER COLUMN locale DROP DEFAULT`.execute(db);
}
