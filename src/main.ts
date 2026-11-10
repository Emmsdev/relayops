import { Logger } from '@nestjs/common';
import { createApi } from './application';
import { readConfig } from './config';

async function main() {
  const config = readConfig();
  const app = await createApi(config);
  app.enableShutdownHooks();
  try {
    await app.listen(config.port, config.host);
    Logger.log(`RelayOps listening on port ${config.port}.`, 'API');
  } catch (error) {
    await app.close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : 'API startup failed.', 'API');
  process.exitCode = 1;
});
