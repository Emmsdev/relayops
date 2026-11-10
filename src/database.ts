import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { CONFIG, Config } from './config';

export function openPool(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 8_000,
  });
  const logger = new Logger('PostgreSQL');
  pool.on('error', () => logger.error('An idle PostgreSQL connection failed.'));
  return pool;
}

@Injectable()
export class Database implements OnApplicationShutdown {
  readonly pool: Pool;

  constructor(@Inject(CONFIG) config: Config) {
    this.pool = openPool(config.databaseUrl);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let reusable = true;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        reusable = false;
      }
      throw error;
    } finally {
      client.release(!reusable);
    }
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
