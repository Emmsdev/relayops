import { createHmac } from 'node:crypto';
import { ClaimedEvent, DeliveryOutcome, REQUEST_TIMEOUT_MS } from '../events/event.contract';

export async function deliver(
  event: ClaimedEvent,
  destination: { url: string; signingSecret: string },
): Promise<DeliveryOutcome> {
  const body = JSON.stringify({
    id: event.deliveryId,
    type: event.type,
    createdAt: event.createdAt,
    payload: event.payload,
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', destination.signingSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(destination.url, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Relay-Event-Id': event.deliveryId,
        'X-Relay-Timestamp': timestamp,
        'X-Relay-Signature': `v1=${signature}`,
        'Idempotency-Key': event.deliveryId,
      },
      body,
    });
    // The status is the acknowledgment. Avoid buffering arbitrary response bodies.
    void response.body?.cancel().catch(() => undefined);

    if (response.ok) return { kind: 'delivered', status: response.status };
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    return { kind: retryable ? 'retryable_http' : 'permanent_http', status: response.status };
  } catch {
    return { kind: signal.aborted ? 'timeout' : 'network_error' };
  }
}

export function retryDelay(attempt: number, random = Math.random) {
  const ceiling = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}
