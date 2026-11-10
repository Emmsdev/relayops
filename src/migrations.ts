import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

export async function runMigrations(pool: Pool, directory = resolve('migrations')) {
  const files = (await readdir(directory)).filter((name) => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();
  if (files.length === 0) throw new Error('No migrations found.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(43219705)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS relay_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const applied = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM relay_migrations',
    );
    const checksums = new Map(applied.rows.map((row) => [row.name, row.checksum]));
    for (const file of files) {
      const sql = await readFile(join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = checksums.get(file);
      if (existing === checksum) continue;
      if (existing) throw new Error(`Applied migration has changed: ${file}`);
      await client.query(sql);
      await client.query('INSERT INTO relay_migrations (name, checksum) VALUES ($1, $2)', [
        file, checksum,
      ]);
    }
    await client.query('COMMIT');
  } finally {
    // Closing this dedicated connection also rolls back an unfinished migration.
    client.release(true);
  }
}
