import 'reflect-metadata';
import { resolve } from 'node:path';
import { ConsoleLogger, DynamicModule, Module } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Config } from './config';
import { DeliveryWorker } from './delivery/delivery.worker';
import { EventsController } from './events/events.controller';
import { WorkspaceGuard } from './events/workspace.guard';
import { HealthController } from './health.controller';
import { ProblemFilter } from './problem.filter';
import { StorageModule } from './storage.module';

@Module({})
class ApiModule {
  static configure(config: Config): DynamicModule {
    return {
      module: ApiModule,
      imports: [StorageModule.configure(config)],
      controllers: [EventsController, HealthController],
      providers: [WorkspaceGuard],
    };
  }
}

@Module({})
class WorkerModule {
  static configure(config: Config): DynamicModule {
    return {
      module: WorkerModule,
      imports: [StorageModule.configure(config)],
      providers: [DeliveryWorker],
    };
  }
}

export async function createApi(config: Config, logger: ConsoleLogger | false = new ConsoleLogger({ json: true })) {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule.configure(config), {
    bodyParser: false, logger, abortOnError: false,
  });
  app.disable('x-powered-by');
  app.useStaticAssets(resolve('public'), {
    prefix: '/console/',
    setHeaders: (response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      response.setHeader('X-Content-Type-Options', 'nosniff');
    },
  });
  app.useBodyParser('json', { limit: '64kb', inflate: false });
  app.useGlobalFilters(new ProblemFilter(app.get(HttpAdapterHost)));
  const spec = new DocumentBuilder()
    .setTitle('RelayOps')
    .setDescription('Enqueue signed webhooks and inspect delivery attempts.')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, spec));
  return app;
}

export function createWorker(config: Config, logger: ConsoleLogger | false = new ConsoleLogger({ json: true })) {
  return NestFactory.createApplicationContext(WorkerModule.configure(config), {
    logger, abortOnError: false,
  });
}
