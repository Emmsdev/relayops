import { Logger } from '@nestjs/common';
import { createWorker } from './application';
import { readConfig } from './config';
import { DeliveryWorker } from './delivery/delivery.worker';

async function main() {
  const app = await createWorker(readConfig());
  app.enableShutdownHooks();
  app.get(DeliveryWorker).start();
  Logger.log('Delivery worker started.', 'Worker');
}

void main().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : 'Worker startup failed.', 'Worker');
  process.exitCode = 1;
});
