const byId = (id) => document.getElementById(id);
const connect = byId('connect');
const publish = byId('publish');
const operations = byId('operations');
const history = byId('events');
const filter = byId('state');
const notice = byId('notice');
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let session;
let selected;
let nextCursor;
let draft;
let busy = false;

function announce(message, error = false) {
  notice.dataset.error = String(error);
  notice.textContent = message;
}

async function run(action) {
  if (busy) return;
  busy = true;
  connect.querySelector('button').disabled = true;
  operations.disabled = true;
  announce('Working…');
  try {
    announce(await action());
  } catch (error) {
    announce(error.message || 'The operation failed.', true);
  } finally {
    operations.disabled = false;
    connect.querySelector('button').disabled = false;
    busy = false;
  }
}

async function request(path = '', { method = 'GET', body, key } = {}) {
  const headers = { Authorization: `Bearer ${session.key}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(`/v1/workspaces/${encodeURIComponent(session.workspace)}/events${path}`, {
    method,
    headers,
    body,
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401) throw new Error('Workspace or key rejected. Check your credentials.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || data.title || `Request failed (${response.status}).`);
  return data;
}

function updateSelection() {
  for (const button of history.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.id === selected?.id));
  }
}

function appendEvent(event) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  const title = document.createElement('strong');
  const badge = document.createElement('span');
  const meta = document.createElement('small');
  button.type = 'button';
  button.className = 'event-row';
  button.dataset.id = event.id;
  button.setAttribute('aria-pressed', String(event.id === selected?.id));
  title.textContent = event.type;
  badge.className = 'badge';
  badge.dataset.state = event.state;
  badge.textContent = event.state;
  const replayLabel = event.replayedBy ? ' · replay created' : event.replayOf ? ' · replay' : '';
  meta.textContent = `${event.destination} · ${date.format(new Date(event.createdAt))}${replayLabel}`;
  button.append(title, badge, meta);
  button.addEventListener('click', () => run(async () => {
    await inspect(event.id);
    return 'Delivery details loaded.';
  }));
  item.append(button);
  history.append(item);
}

async function loadPage(cursor) {
  const query = new URLSearchParams({ limit: '15' });
  if (filter.value) query.set('state', filter.value);
  if (cursor) query.set('cursor', cursor);
  const page = await request(`?${query}`);
  if (!cursor) history.replaceChildren();
  for (const event of page.items) appendEvent(event);
  nextCursor = page.nextCursor;
  byId('empty').hidden = history.childElementCount > 0;
  byId('more').hidden = !nextCursor;
}

async function inspect(id) {
  const event = await request(`/${encodeURIComponent(id)}`);
  selected = event;
  byId('unselected').hidden = true;
  byId('event-detail').hidden = false;
  byId('event-type').textContent = event.type;
  byId('event-id').textContent = event.id;
  byId('event-summary').textContent = `${event.state.toUpperCase()} · ${event.destination} · ${event.attemptCount} attempt(s)`;
  byId('parent').hidden = !event.replayOf;
  byId('child').hidden = !event.replayedBy;
  byId('replay').hidden = event.state !== 'dead' || Boolean(event.replayedBy);
  byId('no-attempts').hidden = event.attempts.length > 0;
  byId('attempts').replaceChildren(...event.attempts.map((attempt) => {
    const item = document.createElement('li');
    const outcome = attempt.outcome?.replaceAll('_', ' ') ?? 'in progress';
    const status = attempt.httpStatus ? ` · HTTP ${attempt.httpStatus}` : '';
    item.textContent = `#${attempt.number} · ${outcome}${status} · ${date.format(new Date(attempt.startedAt))}`;
    return item;
  }));
  updateSelection();
}

connect.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    const data = new FormData(connect);
    session = { workspace: data.get('workspace').trim(), key: data.get('key').trim() };
    try {
      await loadPage();
    } catch (error) {
      session = undefined;
      throw error;
    }
    connect.elements.key.value = '';
    connect.hidden = true;
    byId('workspace').hidden = false;
    byId('connected').textContent = `WORKSPACE / ${session.workspace}`;
    return 'Workspace connected.';
  });
});

byId('disconnect').addEventListener('click', () => {
  session = selected = nextCursor = draft = undefined;
  history.replaceChildren();
  byId('attempts').replaceChildren();
  for (const id of ['event-type', 'event-id', 'event-summary', 'connected']) byId(id).textContent = '';
  byId('event-detail').hidden = true;
  byId('unselected').hidden = false;
  byId('workspace').hidden = true;
  filter.value = '';
  publish.reset();
  connect.hidden = false;
  connect.elements.key.focus();
  announce('Disconnected.');
});

byId('refresh').addEventListener('click', () => run(async () => {
  await loadPage();
  if (selected) await inspect(selected.id);
  return 'History refreshed.';
}));

filter.addEventListener('change', () => run(async () => {
  history.replaceChildren();
  byId('more').hidden = true;
  byId('empty').hidden = true;
  await loadPage();
  return 'Filter applied.';
}));

byId('more').addEventListener('click', () => run(async () => {
  if (nextCursor) await loadPage(nextCursor);
  return 'More events loaded.';
}));

for (const [button, field] of [['parent', 'replayOf'], ['child', 'replayedBy']]) {
  byId(button).addEventListener('click', () => run(async () => {
    await inspect(selected[field]);
    return 'Related delivery opened.';
  }));
}

publish.addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = new FormData(publish);
  void run(async () => {
    let payload;
    try {
      payload = JSON.parse(fields.get('payload'));
    } catch {
      throw new Error('Enter valid JSON in the payload field.');
    }
    const body = JSON.stringify({ type: fields.get('type').trim(), destination: fields.get('destination').trim(), payload });
    if (draft?.body !== body) draft = { body, key: crypto.randomUUID() };
    const accepted = await request('', { method: 'POST', body, key: draft.key });
    draft = undefined;
    filter.value = '';
    try {
      await inspect(accepted.id);
      await loadPage();
      return 'Webhook queued. Use Refresh to check its latest state.';
    } catch (error) {
      throw new Error(`Webhook queued as ${accepted.id}. Refresh failed: ${error.message}`);
    }
  });
});

byId('replay').addEventListener('click', () => run(async () => {
  const accepted = await request(`/${encodeURIComponent(selected.id)}/replay`, { method: 'POST' });
  try {
    await inspect(accepted.id);
    await loadPage();
    return 'Replay queued. Use Refresh to check its latest state.';
  } catch (error) {
    throw new Error(`Replay queued as ${accepted.id}. Refresh failed: ${error.message}`);
  }
}));
