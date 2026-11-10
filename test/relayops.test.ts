import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, IncomingHttpHeaders } from 'node:http';
import { after, before, test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createApi, createWorker } from '../src/application';
import { readConfig } from '../src/config';
import { openPool } from '../src/database';
import { DeliveryWorker } from '../src/delivery/delivery.worker';
import { EventRepository } from '../src/events/event.repository';
import { runMigrations } from '../src/migrations';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');

const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = openPool(testUrl);
const scopedUrl = new URL(testUrl);
scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
const pool = openPool(scopedUrl.href);
const mainKey = 'test_main_workspace_bearer_key_only';
const otherKey = 'test_other_workspace_bearer_key_only';
const signingSecret = 'test_workspace_hmac_signing_secret';
const deliveries: Array<{ body: string; headers: IncomingHttpHeaders }> = [];
let reply: (requestNumber: number) => number = () => 204;
const receiver = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  deliveries.push({ body: Buffer.concat(chunks).toString('utf8'), headers: request.headers });
  response.writeHead(reply(deliveries.length), { Location: '/trap' }).end();
});

let api: Awaited<ReturnType<typeof createApi>> | undefined;
let firstWorker: Awaited<ReturnType<typeof createWorker>> | undefined;
let secondWorker: Awaited<ReturnType<typeof createWorker>> | undefined;
let baseUrl: string;
let worker: DeliveryWorker;
let otherWorker: DeliveryWorker;
let repository: EventRepository;
const path = '/v1/workspaces/main/events';
const event = { type: 'invoice.paid', destination: 'billing', payload: { amount: 12500, currency: 'XAF' } };

before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  assert.ok(address && typeof address !== 'string');
  const destinations = { billing: { url: `http://127.0.0.1:${address.port}/webhooks`, signingSecret } };
  const config = readConfig({
    DATABASE_URL: scopedUrl.href,
    RELAY_ALLOW_HTTP: '1',
    RELAY_WORKSPACES: JSON.stringify({
      main: { apiKey: mainKey, destinations },
      other: { apiKey: otherKey, destinations },
    }),
  });

  api = await createApi(config, false);
  await api.listen(0, '127.0.0.1');
  baseUrl = await api.getUrl();
  assert.equal((await fetch(baseUrl + '/health/live')).status, 200);
  assert.equal((await fetch(baseUrl + '/health/ready')).status, 503);

  await Promise.all([runMigrations(pool), runMigrations(pool)]);
  assert.equal((await pool.query('SELECT name FROM relay_migrations')).rowCount, 2);

  firstWorker = await createWorker(config, false);
  secondWorker = await createWorker(config, false);
  worker = firstWorker.get(DeliveryWorker);
  otherWorker = secondWorker.get(DeliveryWorker);
  repository = firstWorker.get(EventRepository);
});

after(async () => {
  await Promise.all([api?.close(), firstWorker?.close(), secondWorker?.close()]);
  if (receiver.listening) {
    await new Promise<void>((resolve, reject) => receiver.close((error) => error ? reject(error) : resolve()));
  }
  try {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await admin.end();
  }
});

function enqueue(key: string, body: string, bearer: string | undefined = mainKey, target = path) {
  return fetch(baseUrl + target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body,
  });
}

async function accept(key: string) {
  const response = await enqueue(key, JSON.stringify(event));
  assert.equal(response.status, 202);
  return await response.json() as { id: string; statusUrl: string };
}

async function inspect(id: string) {
  const response = await fetch(`${baseUrl}${path}/${id}`, { headers: { authorization: `Bearer ${mainKey}` } });
  assert.equal(response.status, 200);
  return await response.json();
}

test('exposes readiness and OpenAPI and rejects malformed or unauthorized input', async () => {
  assert.equal((await fetch(baseUrl + '/health/ready')).status, 200);
  const docs = await (await fetch(baseUrl + '/docs-json')).json();
  assert.ok(docs.paths['/v1/workspaces/{workspace}/events'].post);
  assert.ok(docs.components.securitySchemes.bearer);

  const body = JSON.stringify(event);
  assert.equal((await enqueue('key', body, '')).status, 401);
  assert.equal((await enqueue('key', body, otherKey)).status, 401);
  assert.equal((await enqueue('key', body, mainKey, '/v1/workspaces/constructor/events')).status, 401);
  assert.equal((await enqueue('', body)).status, 400);
  assert.equal((await enqueue('bad-json', '{"private-marker":')).status, 400);
  const oversized = await enqueue('big', JSON.stringify({ ...event, payload: { data: 'a'.repeat(66_000) } }));
  assert.equal(oversized.status, 413);
  assert.match(oversized.headers.get('content-type') ?? '', /application\/problem\+json/);
  assert.equal((await enqueue('missing', JSON.stringify({ ...event, destination: 'constructor' }))).status, 400);
  assert.equal((await enqueue('unexpected', JSON.stringify({ ...event, url: 'https://example.test' }))).status, 400);
  assert.equal((await enqueue('unicode', JSON.stringify({ ...event, payload: { value: '\u0000' } }))).status, 400);
  const deepPayload = '{"a":'.repeat(33) + '0' + '}'.repeat(33);
  assert.equal((await enqueue('deep', `{"type":"invoice.paid","destination":"billing","payload":${deepPayload}}`)).status, 400);
  assert.equal((await pool.query('SELECT id FROM relay_events')).rowCount, 0);
});

test('deduplicates concurrent requests, isolates workspaces and signs retries with a stable event ID', async () => {
  deliveries.length = 0;
  reply = (number) => number === 1 ? 503 : 204;
  const body = JSON.stringify(event);
  const responses = await Promise.all(Array.from({ length: 8 }, () => enqueue('invoice-42', body)));
  for (const response of responses) assert.equal(response.status, 202);
  const acceptances = await Promise.all(responses.map((response) => response.json()));
  const accepted = acceptances[0];
  for (const acceptance of acceptances) assert.deepEqual(acceptance, accepted);
  const reordered = await enqueue('invoice-42', JSON.stringify({ ...event, payload: { currency: 'XAF', amount: 12500 } }));
  assert.equal(reordered.status, 202);
  assert.deepEqual(await reordered.json(), accepted);
  assert.equal((await enqueue('invoice-42', JSON.stringify({ ...event, payload: { amount: 1 } }))).status, 409);
  assert.equal((await fetch(baseUrl + accepted.statusUrl.replace('/main/', '/other/'), {
    headers: { authorization: `Bearer ${otherKey}` },
  })).status, 404);

  assert.deepEqual((await Promise.all([worker.processOne(), otherWorker.processOne()])).sort(), [false, true]);
  const queued = await inspect(accepted.id);
  assert.equal(queued.state, 'queued');
  assert.equal(queued.attempts[0].outcome, 'retryable_http');

  for (let i = 0; i < 40 && !(await worker.processOne()); i += 1) await setTimeout(35);
  const done = await inspect(accepted.id);
  assert.equal(done.state, 'delivered');
  assert.deepEqual(done.attempts.map((item: { outcome: string }) => item.outcome), ['retryable_http', 'delivered']);
  assert.equal(deliveries.length, 2);
  for (const delivery of deliveries) {
    const expected = createHmac('sha256', signingSecret)
      .update(`${delivery.headers['x-relay-timestamp']}.${delivery.body}`)
      .digest('hex');
    assert.equal(delivery.headers['x-relay-signature'], `v1=${expected}`);
    assert.equal(delivery.headers['idempotency-key'], accepted.id);
    assert.equal(delivery.headers['x-relay-event-id'], accepted.id);
    assert.deepEqual(JSON.parse(delivery.body).payload, event.payload);
  }
});

test('recovers an expired lease and rejects completion from the original worker', async () => {
  deliveries.length = 0;
  reply = () => 204;
  const accepted = await accept('lease');
  const original = await repository.claim();
  assert.equal(original?.id, accepted.id);
  assert.ok(original);
  await pool.query("UPDATE relay_events SET next_run_at = clock_timestamp() WHERE id = $1", [accepted.id]);
  assert.equal(await otherWorker.processOne(), true);
  assert.equal(await repository.finish(original, { kind: 'permanent_http', status: 400 }, 0), undefined);

  const done = await inspect(accepted.id);
  assert.equal(done.state, 'delivered');
  assert.deepEqual(done.attempts.map((item: { outcome: string }) => item.outcome), ['lease_expired', 'delivered']);
});

test('treats redirects as terminal and never contacts the redirect target', async () => {
  deliveries.length = 0;
  reply = () => 307;
  const accepted = await accept('redirect');
  assert.equal(await worker.processOne(), true);

  const done = await inspect(accepted.id);
  assert.equal(done.state, 'dead');
  assert.equal(done.attempts[0].outcome, 'permanent_http');
  assert.equal(done.attempts[0].httpStatus, 307);
  assert.equal(deliveries.length, 1);
});

test('stops retrying after five failures and recovers a crash on the final attempt', async () => {
  deliveries.length = 0;
  reply = () => 503;
  const exhausted = await accept('exhausted');
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await worker.processOne(), true);
    await pool.query("UPDATE relay_events SET next_run_at = clock_timestamp() WHERE id = $1 AND state = 'queued'", [exhausted.id]);
  }
  assert.equal(await worker.processOne(), false);
  assert.equal((await inspect(exhausted.id)).state, 'dead');
  assert.equal(deliveries.length, 5);

  const crashed = await accept('final-crash');
  for (let i = 1; i <= 5; i += 1) {
    assert.equal((await repository.claim())?.attempt, i);
    await pool.query("UPDATE relay_events SET next_run_at = clock_timestamp() WHERE id = $1", [crashed.id]);
  }
  assert.equal(await otherWorker.processOne(), false);
  const dead = await inspect(crashed.id);
  assert.equal(dead.state, 'dead');
  assert.equal(dead.attempts.length, 5);
  assert.ok(dead.attempts.every((attempt: { outcome: string }) => attempt.outcome === 'lease_expired'));
});

test('serves the operator console and pages event history within the authenticated workspace', async () => {
  const consolePage = await fetch(baseUrl + '/console/');
  assert.equal(consolePage.status, 200);
  assert.match(consolePage.headers.get('content-security-policy') ?? '', /form-action 'none'/);
  assert.match(await consolePage.text(), /Delivery console/);
  assert.equal((await fetch(baseUrl + '/console/console.js')).status, 200);

  const headers = { authorization: `Bearer ${mainKey}` };
  assert.equal((await fetch(baseUrl + path + '?limit=101', { headers })).status, 400);
  assert.equal((await fetch(baseUrl + path + '?state=bogus', { headers })).status, 400);
  const pages = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ state: 'dead', limit: '1' });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(`${baseUrl}${path}?${params}`, { headers });
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].state, 'dead');
    pages.push(page.items[0].id);
    cursor = page.nextCursor;
  } while (cursor && pages.length < 5);
  assert.equal(cursor, null);
  assert.equal(pages.length, 3);
  assert.equal(new Set(pages).size, 3);

  const other = await fetch(baseUrl + path.replace('/main/', '/other/') + '?cursor=' + pages[0], {
    headers: { authorization: `Bearer ${otherKey}` },
  });
  assert.equal(other.status, 200);
  assert.deepEqual(await other.json(), { items: [], nextCursor: null });
});

test('replays a dead event once per cycle without changing the signed webhook identity', async () => {
  deliveries.length = 0;
  reply = () => 422;
  const accepted = await accept('replay-original');
  const replay = (id: string, workspace = 'main', key = mainKey) => fetch(
    `${baseUrl}/v1/workspaces/${workspace}/events/${id}/replay`,
    { method: 'POST', headers: { authorization: `Bearer ${key}` } },
  );

  assert.equal((await replay(accepted.id)).status, 409);
  assert.equal(await worker.processOne(), true);
  assert.equal((await replay(accepted.id, 'other', otherKey)).status, 404);
  assert.equal((await replay(accepted.id, 'main', otherKey)).status, 401);
  const responses = await Promise.all(Array.from({ length: 8 }, () => replay(accepted.id)));
  for (const response of responses) assert.equal(response.status, 202);
  const replays = await Promise.all(responses.map((response) => response.json()));
  for (const child of replays) assert.deepEqual(child, replays[0]);
  const firstReplay = replays[0];
  assert.notEqual(firstReplay.id, accepted.id);
  assert.equal(await worker.processOne(), true);
  assert.equal((await inspect(firstReplay.id)).state, 'dead');

  reply = () => 204;
  const next = await replay(firstReplay.id);
  assert.equal(next.status, 202);
  const secondReplay = await next.json();
  assert.equal(await worker.processOne(), true);
  assert.equal(await worker.processOne(), false);
  assert.equal((await inspect(secondReplay.id)).state, 'delivered');
  assert.equal((await replay(secondReplay.id)).status, 409);
  assert.deepEqual(await (await replay(accepted.id)).json(), firstReplay);

  const original = await inspect(accepted.id);
  const intermediate = await inspect(firstReplay.id);
  assert.equal(original.replayedBy, firstReplay.id);
  assert.equal(original.state, 'dead');
  assert.equal(original.attempts[0].httpStatus, 422);
  assert.equal(intermediate.replayOf, accepted.id);
  assert.equal(intermediate.replayedBy, secondReplay.id);
  assert.equal(deliveries.length, 3);
  for (const delivery of deliveries) {
    assert.equal(delivery.body, deliveries[0]?.body);
    assert.equal(delivery.headers['idempotency-key'], accepted.id);
    assert.equal(delivery.headers['x-relay-event-id'], accepted.id);
  }
});
