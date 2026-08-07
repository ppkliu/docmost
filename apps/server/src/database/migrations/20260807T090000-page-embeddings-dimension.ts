import { type Kysely, sql } from 'kysely';

// Aligns page_embeddings.embedding with AI_EMBEDDING_DIMENSION.
//
// The original migration froze the column at whatever AI_EMBEDDING_DIMENSION
// was when the table was first created (default 1536). Deployments that later
// pick a differently-sized model — bge-m3 is 1024, for instance — end up with a
// column that rejects every write. The failure surfaces during indexing rather
// than at configuration time, so it is easy to misread as "AI Search is broken".
//
// ★ Refuses to touch a non-empty table. Changing the dimension invalidates
//   every stored vector, and silently discarding embeddings during a migration
//   is not a decision this file gets to make. Operators who do want that run
//   TRUNCATE page_embeddings first; the log line below says so.
export async function up(db: Kysely<any>): Promise<void> {
  const target = parseInt(process.env.AI_EMBEDDING_DIMENSION || '1536', 10);
  if (!Number.isFinite(target) || target <= 0) return;

  const current = await currentDimension(db);
  if (current === null || current === target) return;

  const { rows } = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM page_embeddings`.execute(db);
  if (Number(rows[0]?.n ?? 0) > 0) {
    console.warn(
      `[page-embeddings] AI_EMBEDDING_DIMENSION=${target} but the column is ` +
        `vector(${current}) and the table is not empty. Leaving it unchanged — ` +
        'stored vectors would all become invalid. To switch models, run ' +
        'TRUNCATE page_embeddings; and re-run migrations.',
    );
    return;
  }

  // The HNSW index carries the dimension too, so it has to go and come back.
  await sql`DROP INDEX IF EXISTS page_embeddings_embedding_hnsw_idx`.execute(db);
  await sql`
    ALTER TABLE page_embeddings
    ALTER COLUMN embedding TYPE vector(${sql.raw(String(target))})
  `.execute(db);
  await sql`
    CREATE INDEX page_embeddings_embedding_hnsw_idx
    ON page_embeddings USING hnsw (embedding vector_cosine_ops)
  `.execute(db);
}

// Irreversible by design: the previous dimension is not recoverable from the
// schema once changed, and no vectors survive the switch anyway.
export async function down(): Promise<void> {
  // no-op
}

/**
 * Reads the declared dimension of the embedding column, or null if the table
 * or column is absent (fresh install — the creating migration already used the
 * right dimension, so there is nothing to align).
 *
 * ★ Parses format_type() rather than reading atttypmod directly: how a type
 *   packs its modifier is type-specific, and "vector(1536)" is unambiguous.
 */
async function currentDimension(db: Kysely<any>): Promise<number | null> {
  const { rows } = await sql<{ declared: string }>`
    SELECT format_type(a.atttypid, a.atttypmod) AS declared
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'page_embeddings'
       AND n.nspname = current_schema()
       AND a.attname = 'embedding'
       AND a.attnum > 0
       AND NOT a.attisdropped
  `.execute(db);
  const m = /\((\d+)\)/.exec(rows[0]?.declared ?? '');
  return m ? Number(m[1]) : null;
}
