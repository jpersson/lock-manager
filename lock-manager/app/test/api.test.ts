import { afterEach, describe, expect, it } from 'vitest';
import { backDoor, createHarness, frontDoor, type TestHarness } from './fakes.js';

const harnesses: TestHarness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.cleanup();
  }
});

async function harness(opts?: Parameters<typeof createHarness>[0]): Promise<TestHarness> {
  const h = await createHarness(opts);
  harnesses.push(h);
  return h;
}

async function manageFrontDoor(h: TestHarness): Promise<void> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/locks',
    payload: { lockId: frontDoor.id },
  });
  expect(res.statusCode).toBe(201);
}

describe('locks API', () => {
  it('lists discovered (unmanaged) and managed locks together', async () => {
    const h = await harness();
    h.discovery.publish([frontDoor, backDoor]);
    await manageFrontDoor(h);

    const res = await h.app.inject({ method: 'GET', url: '/api/locks' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      locks: Array<{ id: string; managed: boolean; discovered: boolean }>;
    };
    const byId = new Map(body.locks.map((l) => [l.id, l]));
    expect(byId.get(frontDoor.id)).toMatchObject({ managed: true, discovered: true });
    expect(byId.get(backDoor.id)).toMatchObject({ managed: false, discovered: true });
  });

  it('keeps managed locks visible when they drop out of discovery (offline)', async () => {
    const h = await harness();
    h.discovery.publish([frontDoor]);
    await manageFrontDoor(h);
    h.discovery.publish([]); // lock went offline / Z2M restarted

    const res = await h.app.inject({ method: 'GET', url: '/api/locks' });
    const body = res.json() as { locks: Array<{ id: string; managed: boolean; discovered: boolean }> };
    expect(body.locks).toHaveLength(1);
    expect(body.locks[0]).toMatchObject({ id: frontDoor.id, managed: true, discovered: false });
  });

  it('rejects managing an unknown lock id', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/locks',
      payload: { lockId: '0xunknown' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Lock is not discovered' });
  });

  it('unmanages a lock (204) and 404s for unknown locks', async () => {
    const h = await harness();
    h.discovery.publish([frontDoor]);
    await manageFrontDoor(h);
    const del = await h.app.inject({ method: 'DELETE', url: `/api/locks/${frontDoor.id}` });
    expect(del.statusCode).toBe(204);
    const again = await h.app.inject({ method: 'DELETE', url: `/api/locks/${frontDoor.id}` });
    expect(again.statusCode).toBe(404);
  });
});

describe('users API', () => {
  it('full lifecycle: create → edit (empty PIN keeps) → delete', async () => {
    const h = await harness();
    h.discovery.publish([frontDoor]);
    await manageFrontDoor(h);

    const create = await h.app.inject({
      method: 'POST',
      url: `/api/locks/${frontDoor.id}/users`,
      payload: { slot: 2, name: 'Alice', pin: '1234' },
    });
    expect(create.statusCode).toBe(201);
    const created = (create.json() as { user: Record<string, unknown> }).user;
    expect(created).toMatchObject({ slot: 2, name: 'Alice', hasPin: true, status: 'pending' });
    // the PIN is never exposed
    expect(create.body.includes('1234')).toBe(false);

    const edit = await h.app.inject({
      method: 'PATCH',
      url: `/api/locks/${frontDoor.id}/users/2`,
      payload: { name: 'Alice B' }, // no pin → keeps stored PIN
    });
    expect(edit.statusCode).toBe(200);
    expect((edit.json() as { user: Record<string, unknown> }).user).toMatchObject({
      name: 'Alice B',
      hasPin: true,
    });

    const del = await h.app.inject({
      method: 'DELETE',
      url: `/api/locks/${frontDoor.id}/users/2`,
    });
    expect(del.statusCode).toBe(204);
    // removal published the clear payload
    expect(h.mqtt.published).toEqual([
      { topic: 'front_door/set', payload: { pin_code: { user: 2 } } },
    ]);
  });

  it('rejects invalid payloads and unknown locks', async () => {
    const h = await harness();
    h.discovery.publish([frontDoor]);
    await manageFrontDoor(h);

    const badSlot = await h.app.inject({
      method: 'POST',
      url: `/api/locks/${frontDoor.id}/users`,
      payload: { slot: -1, name: 'X' },
    });
    expect(badSlot.statusCode).toBe(400);

    const badName = await h.app.inject({
      method: 'POST',
      url: `/api/locks/${frontDoor.id}/users`,
      payload: { slot: 1, name: '' },
    });
    expect(badName.statusCode).toBe(400);

    const unmanaged = await h.app.inject({
      method: 'POST',
      url: `/api/locks/${backDoor.id}/users`,
      payload: { slot: 1, name: 'X' },
    });
    expect(unmanaged.statusCode).toBe(404);

    const missingUser = await h.app.inject({
      method: 'PATCH',
      url: `/api/locks/${frontDoor.id}/users/5`,
      payload: { name: 'Nobody' },
    });
    expect(missingUser.statusCode).toBe(404);
  });

  it('delete on a missing user 404s; failed clear returns 502 and keeps the entry', async () => {
    const h = await harness({ mqtt: undefined });
    h.discovery.publish([frontDoor]);
    await manageFrontDoor(h);

    const missing = await h.app.inject({
      method: 'DELETE',
      url: `/api/locks/${frontDoor.id}/users/7`,
    });
    expect(missing.statusCode).toBe(404);

    h.store.upsertUser(frontDoor.id, { slot: 3, name: 'Bob', pin: '4321' });
    h.mqtt.failTopics.add('front_door/set');
    const failed = await h.app.inject({
      method: 'DELETE',
      url: `/api/locks/${frontDoor.id}/users/3`,
    });
    expect(failed.statusCode).toBe(502);
    expect(h.store.getUser(frontDoor.id, 3)).toBeDefined();
  });
});

describe('apply-pin API', () => {
  it('applies a PIN to multiple locks in one action', async () => {
    const h = await harness();
    h.discovery.publish([frontDoor, backDoor]);
    await manageFrontDoor(h);
    await h.app.inject({ method: 'POST', url: '/api/locks', payload: { lockId: backDoor.id } });

    await h.app.inject({
      method: 'POST',
      url: `/api/locks/${frontDoor.id}/users`,
      payload: { slot: 1, name: 'Alice', pin: '5678' },
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/locks/${frontDoor.id}/users/1/apply-pin`,
      payload: { targetLockIds: [backDoor.id] },
      headers: { 'x-remote-user-name': 'ha-admin' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ lockId: string; ok: boolean }> };
    expect(body.results).toEqual([
      { lockId: frontDoor.id, ok: true },
      { lockId: backDoor.id, ok: true },
    ]);
    const topics = h.mqtt.published.map((p) => p.topic).sort();
    expect(topics).toEqual(['front_door/set', 'garage/back_door/set']);
    expect(h.store.getUser(backDoor.id, 1)?.status).toBe('applied');
    // audit trail captured the HA user
    const activity = h.store.getActivity(50).entries.find((e) => e.type === 'pin-apply');
    expect(activity?.byUser).toBe('ha-admin');
  });

  it('returns 400 when no PIN is stored for the slot', async () => {
    const h = await harness();
    h.discovery.publish([frontDoor]);
    await manageFrontDoor(h);
    await h.app.inject({
      method: 'POST',
      url: `/api/locks/${frontDoor.id}/users`,
      payload: { slot: 4, name: 'NoPinUser' },
    });

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/locks/${frontDoor.id}/users/4/apply-pin`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/No PIN stored/);
  });

  it('reports per-target failures in the result set', async () => {
    const h = await harness();
    h.discovery.publish([frontDoor, backDoor]);
    await manageFrontDoor(h);
    await h.app.inject({ method: 'POST', url: '/api/locks', payload: { lockId: backDoor.id } });
    h.store.upsertUser(frontDoor.id, { slot: 1, name: 'Alice', pin: '1111' });
    h.mqtt.failTopics.add('garage/back_door/set');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/locks/${frontDoor.id}/users/1/apply-pin`,
      payload: { targetLockIds: [backDoor.id] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Array<{ lockId: string; ok: boolean; error?: string }> };
    expect(body.results).toHaveLength(2);
    const backResult = body.results.find((r) => r.lockId === backDoor.id);
    expect(backResult?.ok).toBe(false);
    expect(backResult?.error).toBe('broker unreachable');
  });
});

describe('activity API', () => {
  it('lists activity newest-first with paging and lock filter', async () => {
    const h = await harness();
    h.discovery.publish([frontDoor]);
    await manageFrontDoor(h);
    h.store.upsertUser(frontDoor.id, { slot: 1, name: 'Alice' });

    h.mqtt.deliver('front_door', { action: 'unlock', action_source_name: 'keypad', action_user: 1 });
    h.mqtt.deliver('front_door', { action: 'manual_lock' });

    const res = await h.app.inject({ method: 'GET', url: '/api/activity?limit=1&offset=0' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: Array<{ type: string; slot?: number; userName?: string }>;
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.entries).toHaveLength(1);
    // newest first
    expect(body.entries[0]?.type).toBe('manual');

    const filtered = await h.app.inject({
      method: 'GET',
      url: `/api/activity?lockId=${backDoor.id}`,
    });
    expect((filtered.json() as { total: number }).total).toBe(0);
  });
});

describe('settings API', () => {
  it('GET reports effective values and overrides', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json()).toEqual({
      notifyTarget: 'notify.notify',
      notifyTargetOverride: null,
      notificationsEnabled: true,
      notificationsEnabledOverride: null,
    });
  });

  it('PUT sets overrides and null clears them back to add-on defaults', async () => {
    const h = await harness();
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { notifyTarget: 'notify.mobile_app_pixel', notificationsEnabled: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      notifyTarget: 'notify.mobile_app_pixel',
      notificationsEnabled: false,
    });

    const clear = await h.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { notifyTarget: null, notificationsEnabled: null },
    });
    expect(clear.json()).toMatchObject({
      notifyTarget: 'notify.notify',
      notificationsEnabled: true,
    });
  });

  it('rejects invalid payloads', async () => {
    const h = await harness();
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { notifyTarget: 42 },
    });
    expect(res.statusCode).toBe(400);
  });
});