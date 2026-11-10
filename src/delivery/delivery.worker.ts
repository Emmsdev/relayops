import { BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { CONFIG, Config } from '../config';
import { EventRepository } from '../events/event.repository';
import { deliver, retryDelay } from './transport';

@Injectable()
export class DeliveryWorker implements BeforeApplicationShutdown {
  private readonly logger = new Logger(DeliveryWorker.name);
  private readonly stop = new AbortController();
  private running?: Promise<void>;

  constructor(
    private readonly events: EventRepository,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  start() {
    this.running ??= this.loop();
  }

  private async loop() {
    while (!this.stop.signal.aborted) {
      let delay = 250;
      try {
        if (await this.processOne()) continue;
      } catch {
        this.logger.error('Queue processing failed. Unfinished attempts are recovered after lease expiry.');
        delay = 1_000;
      }
      await setTimeout(delay, undefined, { signal: this.stop.signal }).catch((error: unknown) => {
        if (!this.stop.signal.aborted) throw error;
      });
    }
  }

  async processOne() {
    const event = await this.events.claim();
    if (!event) return false;

    const workspace = Object.hasOwn(this.config.workspaces, event.workspace)
      ? this.config.workspaces[event.workspace] : undefined;
    const destinations = workspace?.destinations;
    const destination = destinations && Object.hasOwn(destinations, event.destination)
      ? destinations[event.destination] : undefined;

    const outcome = destination
      ? await deliver(event, destination)
      : { kind: 'destination_missing' as const };
    const state = await this.events.finish(event, outcome, retryDelay(event.attempt));
    this.logger.log({
      eventId: event.id,
      attempt: event.attempt,
      state: state ?? 'stale',
      outcome: outcome.kind,
      httpStatus: outcome.status ?? null,
    });
    return true;
  }

  async beforeApplicationShutdown() {
    this.stop.abort();
    await this.running;
  }
}
