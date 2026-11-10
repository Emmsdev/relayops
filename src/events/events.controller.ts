import {
  Body, Controller, Get, Header, Headers, HttpCode,
  HttpStatus, Inject, Param, ParseUUIDPipe, Post, UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse, ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { CONFIG, Config } from '../config';
import { problem } from '../problem.filter';
import { eventInput, idempotencyKey } from './event.contract';
import { EventRepository } from './event.repository';
import { WorkspaceGuard } from './workspace.guard';

@ApiTags('Events')
@ApiBearerAuth()
@ApiParam({ name: 'workspace', example: 'demo' })
@ApiResponse({ status: 401, description: 'Missing or invalid workspace key.' })
@UseGuards(WorkspaceGuard)
@Controller('v1/workspaces/:workspace/events')
export class EventsController {
  constructor(
    private readonly events: EventRepository,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Enqueue a webhook for a configured destination' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, example: 'invoice-123' })
  @ApiBody({ schema: {
    type: 'object',
    required: ['type', 'destination', 'payload'],
    additionalProperties: false,
    properties: {
      type: { type: 'string', example: 'invoice.paid' },
      destination: { type: 'string', example: 'billing' },
      payload: { type: 'object', example: { invoiceId: 'INV-123' } },
    },
  } })
  @ApiAcceptedResponse({
    description: 'Event accepted or already accepted with the same key.',
    schema: { example: {
      id: 'e8a2c273-ffbe-4b11-8ded-8bf8d3240193',
      createdAt: '2026-11-10T12:00:00.000Z',
      statusUrl: '/v1/workspaces/demo/events/e8a2c273-ffbe-4b11-8ded-8bf8d3240193',
    } },
  })
  @ApiResponse({ status: 400, description: 'Invalid input or unknown destination.' })
  @ApiResponse({ status: 409, description: 'The key was used with different event data.' })
  async enqueue(
    @Param('workspace') workspace: string,
    @Headers('idempotency-key') rawKey: unknown,
    @Body() body: unknown,
  ) {
    const key = idempotencyKey.safeParse(rawKey);
    if (!key.success) throw problem(400, 'A valid Idempotency-Key header is required.');
    const parsed = eventInput.safeParse(body);
    if (!parsed.success) throw problem(400, 'Expected type, destination and an object payload.');

    const destinations = this.config.workspaces[workspace]?.destinations;
    if (!destinations || !Object.hasOwn(destinations, parsed.data.destination)) {
      throw problem(400, 'Unknown destination for this workspace.');
    }
    const accepted = await this.events.enqueue(workspace, key.data, parsed.data).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error &&
        (error.code === '22P05' || error.code === '22021')) {
        throw problem(400, 'Payload contains unsupported Unicode characters.');
      }
      throw error;
    });
    if (!accepted) throw problem(409, 'This Idempotency-Key was used with different event data.');

    return { ...accepted, statusUrl: `/v1/workspaces/${workspace}/events/${accepted.id}` };
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Inspect a webhook and its delivery attempts' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Event state and attempt history.' })
  @ApiResponse({ status: 404, description: 'Event is absent from this workspace.' })
  async get(@Param('workspace') workspace: string, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    const event = await this.events.find(workspace, id);
    if (!event) throw problem(404, 'Event not found.');
    return event;
  }
}
