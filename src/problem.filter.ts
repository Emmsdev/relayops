import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { STATUS_CODES } from 'node:http';

export function problem(status: number, detail: string) {
  return new HttpException({ detail }, status);
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemFilter.name);

  constructor(private readonly adapter: HttpAdapterHost) {}

  catch(error: unknown, host: ArgumentsHost) {
    const { httpAdapter } = this.adapter;
    const response = host.switchToHttp().getResponse();
    const status = error instanceof HttpException ? error.getStatus() : this.externalStatus(error);
    const content = error instanceof HttpException ? error.getResponse() : undefined;
    const detail = content && typeof content === 'object' && 'detail' in content &&
      typeof content.detail === 'string' ? content.detail : undefined;
    if (status >= 500) this.logger.error(`Request failed with HTTP ${status}.`);

    if (status === 401) httpAdapter.setHeader(response, 'WWW-Authenticate', 'Bearer');
    httpAdapter.setHeader(response, 'Cache-Control', 'no-store');
    httpAdapter.setHeader(response, 'Content-Type', 'application/problem+json');
    httpAdapter.reply(response, JSON.stringify({
      type: 'about:blank',
      title: STATUS_CODES[status] ?? 'Request failed',
      status,
      ...(detail ? { detail } : {}),
    }), status);
  }

  private externalStatus(error: unknown) {
    if (error && typeof error === 'object' && 'statusCode' in error &&
      (error.statusCode === 400 || error.statusCode === 413 || error.statusCode === 415)) {
      return error.statusCode;
    }
    return 500;
  }
}
