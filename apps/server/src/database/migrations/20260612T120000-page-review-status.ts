import { type Kysely } from 'kysely';

// H2 phase 1: review state for agent-submitted pages.
// null = normal page (default for human-created content);
// 'pending' | 'approved' | 'rejected' for content submitted with requestReview.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('pages')
    .addColumn('review_status', 'varchar', (col) => col)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('pages').dropColumn('review_status').execute();
}
