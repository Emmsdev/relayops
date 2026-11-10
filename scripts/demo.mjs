import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

const workspace = JSON.parse(process.env.RELAY_WORKSPACES ?? '{}').demo;
const billing = workspace?.destinations?.billing;
if (!workspace || !billing) {
  throw new Error('Copy .env.example to .env and configure the demo workspace.');
}

function startReceiver() {
  const firstAttempts = new Map();
  async function receive(request, response) {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'POST' || request.url !== '/webhooks') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 70_000) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);
    const timestamp = request.headers['x-relay-timestamp'];
    const signature = request.headers['x-relay-signature'];
    const id = request.headers['x-relay-event-id'];
    if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      typeof signature !== 'string' || !/^v1=[a-f0-9]{64}$/.test(signature) ||
      typeof id !== 'string' || request.headers['idempotency-key'] !== id) {
      response.writeHead(401).end();
      return;
    }
    const expected = createHmac('sha256', billing.signingSecret)
      .update(`${timestamp}.`).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'))) {
      response.writeHead(401).end();
      return;
    }
    let type;
    try {
      type = JSON.parse(body.toString('utf8'))?.type;
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (!firstAttempts.has(id)) {
      const expiry = globalThis.setTimeout(() => firstAttempts.delete(id), type === 'demo.recover' ? 3_600_000 : 60_000);
      expiry.unref();
      firstAttempts.set(id, expiry);
      response.writeHead(type === 'demo.recover' ? 422 : 503).end();
      return;
    }
    response.writeHead(204).end();
  }
  const server = createServer((request, response) => {
    void receive(request, response).catch(() => response.destroy());
  });
  server.listen(4000, process.env.HOST ?? '127.0.0.1', () => {
    process.stdout.write('Demo receiver is listening on port 4000.\n');
  });
}

async function runDemo() {
  const api = process.env.DEMO_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const key = randomUUID();
  const headers = {
    authorization: `Bearer ${workspace.apiKey}`,
    'idempotency-key': key,
    'content-type': 'application/json',
  };
  const body = JSON.stringify({
    type: 'invoice.paid',
    destination: 'billing',
    payload: { invoiceId: `DEMO-${key.slice(0, 8)}`, amount: 12500, currency: 'XAF' },
  });
  const enqueue = async () => {
    const response = await fetch(`${api}/v1/workspaces/demo/events`, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(3_000),
    });
    if (response.status !== 202) throw new Error(`Enqueue returned HTTP ${response.status}.`);
    return response.json();
  };
  const accepted = await enqueue();
  const repeated = await enqueue();
  if (accepted.id !== repeated.id) throw new Error('The duplicate returned a different event ID.');
  process.stdout.write(`Accepted ${accepted.id}. Duplicate returned the same ID.\n`);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(api + accepted.statusUrl, { headers, signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`Inspection returned HTTP ${response.status}.`);
    const detail = await response.json();
    if (detail.state === 'dead') throw new Error('The event reached the dead state.');
    if (detail.state === 'delivered') {
      const statuses = detail.attempts.map((attempt) => attempt.httpStatus);
      if (statuses.length !== 2 || statuses[0] !== 503 || statuses[1] !== 204) {
        throw new Error(`Expected the demo receiver to answer 503 then 204. Got ${statuses.join(', ')}.`);
      }
      process.stdout.write('Verified signed delivery and retry: 503 → 204.\n');
      return;
    }
    await setTimeout(150);
  }
  throw new Error('Timed out waiting for delivery. Check API and worker logs.');
}

if (process.argv[2] === 'receiver') startReceiver();
else await runDemo();
