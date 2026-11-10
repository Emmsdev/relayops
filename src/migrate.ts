import { Logger } from '@nestjs/common';
import { readDatabaseUrl } from './config';
import { openPool } from './database';
import { runMigrations } from './migrations';

async function main() {
  const pool = openPool(readDatabaseUrl());
  try {
    await runMigrations(pool);
    Logger.log('Database migrations are up to date.', 'Migrations');
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : 'Migration failed.', 'Migrations');
  process.exitCode = 1;
});
