import { z } from 'zod';

export const workspaceSlug = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const secret = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const destination = z.strictObject({
  url: z.url(),
  signingSecret: secret,
});
const workspaces = z.record(workspaceSlug, z.strictObject({
  apiKey: secret,
  destinations: z.record(workspaceSlug, destination),
}));

const databaseUrl = z.url({ protocol: /^postgres(ql)?$/ });

export function readDatabaseUrl(value = process.env.DATABASE_URL): string {
  const parsed = databaseUrl.safeParse(value);
  if (!parsed.success) throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  return parsed.data;
}

export function readConfig(env = process.env) {
  const port = z.coerce.number().int().min(1).max(65535).parse(env.PORT ?? '3000');
  const host = env.HOST ?? '127.0.0.1';
  let rawWorkspaces: unknown;
  try {
    rawWorkspaces = JSON.parse(env.RELAY_WORKSPACES ?? '{}');
  } catch {
    throw new Error('RELAY_WORKSPACES must be valid JSON.');
  }
  const parsed = workspaces.safeParse(rawWorkspaces);
  if (!parsed.success || !Object.keys(parsed.data).length) {
    throw new Error('RELAY_WORKSPACES must define at least one valid workspace.');
  }

  const apiKeys = new Set<string>();
  for (const workspace of Object.values(parsed.data)) {
    if (apiKeys.has(workspace.apiKey)) throw new Error('Workspace keys must be distinct.');
    apiKeys.add(workspace.apiKey);
    if (!Object.keys(workspace.destinations).length) {
      throw new Error('Each workspace needs at least one destination.');
    }
    for (const target of Object.values(workspace.destinations)) {
      const url = new URL(target.url);
      const allowedProtocol = url.protocol === 'https:' ||
        (env.RELAY_ALLOW_HTTP === '1' && url.protocol === 'http:');
      if (!allowedProtocol || url.username || url.password || url.hash) {
        throw new Error('Destinations require HTTPS and URLs without credentials or fragments.');
      }
      target.url = url.href;
    }
  }
  return { databaseUrl: readDatabaseUrl(env.DATABASE_URL), host, port, workspaces: parsed.data };
}

export type Config = ReturnType<typeof readConfig>;
export const CONFIG = Symbol('relayops.config');
