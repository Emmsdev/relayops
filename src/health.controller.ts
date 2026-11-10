import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Database } from './database';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly db: Database) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const { rows } = await this.db.pool.query<{ ready: boolean }>(`
      SELECT to_regclass('relay_events') IS NOT NULL
         AND to_regclass('relay_attempts') IS NOT NULL AS ready
    `).catch(() => { throw new ServiceUnavailableException(); });
    if (!rows[0]?.ready) throw new ServiceUnavailableException();
    return { status: 'ready' };
  }
}
