import { z } from 'zod';
import { workspaceSlug } from '../config';

function isJsonPayload(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  function isJson(node: unknown, depth: number): boolean {
    if (depth > 32) return false;
    if (typeof node === 'number') {
      return Number.isFinite(node) && (!Number.isInteger(node) || Number.isSafeInteger(node));
    }
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return true;
    return typeof node === 'object' && Object.values(node).every((child) => isJson(child, depth + 1));
  }

  return isJson(value, 0);
}

export const eventInput = z.strictObject({
  type: z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/),
  destination: workspaceSlug,
  payload: z.custom<Record<string, unknown>>(isJsonPayload),
});

export const idempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export type EventInput = z.infer<typeof eventInput>;
export type EventState = 'queued' | 'sending' | 'delivered' | 'dead';

export type DeliveryOutcome =
  | { kind: 'delivered' | 'retryable_http' | 'permanent_http'; status: number }
  | { kind: 'timeout' | 'network_error' | 'destination_missing'; status?: never };

export interface ClaimedEvent {
  id: string;
  workspace: string;
  destination: string;
  type: string;
  payload: EventInput['payload'];
  createdAt: Date;
  attempt: number;
}

export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 5_000;
