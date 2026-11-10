import { DynamicModule, Module } from '@nestjs/common';
import { CONFIG, Config } from './config';
import { Database } from './database';
import { EventRepository } from './events/event.repository';

@Module({})
export class StorageModule {
  static configure(config: Config): DynamicModule {
    return {
      module: StorageModule,
      providers: [{ provide: CONFIG, useValue: config }, Database, EventRepository],
      exports: [CONFIG, Database, EventRepository],
    };
  }
}
