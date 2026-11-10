import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual, createHash } from 'node:crypto';
import { CONFIG, Config } from '../config';

function digest(value: string) {
  return createHash('sha256').update(value).digest();
}

@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(context: ExecutionContext) {
    const { params, headers } = context.switchToHttp().getRequest<{
      params: { workspace: string };
      headers: { authorization?: string };
    }>();
    const provided = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(headers.authorization ?? '')?.[1];
    const workspace = Object.hasOwn(this.config.workspaces, params.workspace)
      ? this.config.workspaces[params.workspace] : undefined;

    if (!workspace || !provided || !timingSafeEqual(digest(provided), digest(workspace.apiKey))) {
      throw new UnauthorizedException('A valid workspace bearer key is required.');
    }
    return true;
  }
}
