import type { FastifyInstance } from 'fastify';
import type { Store } from '../store/store.js';
import type { UserEntry } from '../store/types.js';
import type { LockManager, PinApplyResult } from '../domain/lockManager.js';
import type { DiscoveryService } from '../mqtt/discovery.js';
import type { TopicClient } from '../mqtt/client.js';
import type { Logger } from '../logger.js';

/**
 * HTTP API consumed by the Ingress SPA.
 *
 * Notes on authorization: the sidebar panel is admin-only (panel_admin in the
 * add-on manifest, enforced by Home Assistant). The Supervisor adds
 * X-Remote-User-* headers for Ingress requests; we record the acting user for
 * the audit trail but cannot (and need not) re-verify admin status in-app.
 */

export interface ApiDeps {
  store: Store;
  manager: LockManager;
  discovery: DiscoveryService;
  mqtt: TopicClient;
  logger: Logger;
}

interface UserView {
  slot: number;
  name: string;
  hasPin: boolean;
  status?: UserEntry['status'];
  lastAppliedAt?: string;
  lastError?: string;
}

function userView(entry: UserEntry): UserView {
  return {
    slot: entry.slot,
    name: entry.name,
    hasPin: entry.pinEnc !== undefined,
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.lastAppliedAt !== undefined ? { lastAppliedAt: entry.lastAppliedAt } : {}),
    ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
  };
}

interface LockView {
  id: string;
  friendlyName: string;
  model?: string;
  vendor?: string;
  managed: boolean;
  discovered: boolean;
  users?: UserView[];
}

const nameSchema = { type: 'string', minLength: 1, maxLength: 64 } as const;
const pinSchema = { anyOf: [{ type: 'string', minLength: 4, maxLength: 12 }, { type: 'string', maxLength: 0 }] } as const;

function actingUser(headers: Record<string, unknown>): string | undefined {
  const raw = headers['x-remote-user-name'];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

export function registerRoutes(app: FastifyInstance, deps: ApiDeps): void {
  // ---------------------------------------------------------------- locks

  app.get('/api/locks', async () => {
    const discovered = new Map(deps.discovery.getDiscovered().map((l) => [l.id, l]));
    const locks: LockView[] = [];

    for (const lock of Object.values(deps.store.locks)) {
      const isDiscovered = discovered.has(lock.id);
      const meta = discovered.get(lock.id);
      locks.push({
        id: lock.id,
        friendlyName: lock.friendlyName,
        ...(meta?.model ?? lock.model ? { model: meta?.model ?? lock.model } : {}),
        ...(meta?.vendor ?? lock.vendor ? { vendor: meta?.vendor ?? lock.vendor } : {}),
        managed: true,
        discovered: isDiscovered,
        users: lock.users.map(userView),
      });
    }
    for (const [id, lock] of discovered) {
      if (deps.store.getLock(id) === undefined) {
        locks.push({
          id,
          friendlyName: lock.friendlyName,
          ...(lock.model ? { model: lock.model } : {}),
          ...(lock.vendor ? { vendor: lock.vendor } : {}),
          managed: false,
          discovered: true,
        });
      }
    }
    return { locks };
  });

  app.post<{ Body: { lockId?: unknown } }>(
    '/api/locks',
    {
      schema: {
        body: {
          type: 'object',
          required: ['lockId'],
          properties: { lockId: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const lockId = request.body.lockId as string;
      const discovered = deps.discovery.getDiscovered().find((l) => l.id === lockId);
      if (discovered === undefined) {
        return reply.status(404).send({ error: 'Lock is not discovered' });
      }
      const lock = deps.manager.manageLock(discovered);
      return reply.status(201).send({
        lock: {
          id: lock.id,
          friendlyName: lock.friendlyName,
          managed: true,
          discovered: true,
        },
      });
    },
  );

  app.delete<{ Params: { lockId: string } }>('/api/locks/:lockId', async (request, reply) => {
    const ok = deps.manager.unmanageLock(request.params.lockId);
    if (!ok) {
      return reply.status(404).send({ error: 'Lock is not managed' });
    }
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- users

  app.get<{ Params: { lockId: string } }>('/api/locks/:lockId/users', async (request, reply) => {
    const lock = deps.store.getLock(request.params.lockId);
    if (lock === undefined) {
      return reply.status(404).send({ error: 'Lock is not managed' });
    }
    return { users: lock.users.map(userView) };
  });

  app.post<{ Params: { lockId: string }; Body: { slot?: unknown; name?: unknown; pin?: unknown } }>(
    '/api/locks/:lockId/users',
    {
      schema: {
        body: {
          type: 'object',
          required: ['slot', 'name'],
          properties: {
            slot: { type: 'integer', minimum: 0, maximum: 999 },
            name: nameSchema,
            pin: pinSchema,
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { lockId } = request.params;
      if (deps.store.getLock(lockId) === undefined) {
        return reply.status(404).send({ error: 'Lock is not managed' });
      }
      try {
        const entry = deps.store.upsertUser(lockId, {
          slot: request.body.slot as number,
          name: request.body.name as string,
          ...(request.body.pin !== undefined ? { pin: request.body.pin as string } : {}),
        });
        return reply.status(201).send({ user: userView(entry) });
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    },
  );

  app.patch<{ Params: { lockId: string; slot: string }; Body: { name?: unknown; pin?: unknown } }>(
    '/api/locks/:lockId/users/:slot',
    {
      schema: {
        body: {
          type: 'object',
          properties: { name: nameSchema, pin: pinSchema },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { lockId } = request.params;
      const slot = Number(request.params.slot);
      const existing = deps.store.getUser(lockId, slot);
      if (existing === undefined) {
        return reply.status(404).send({ error: `No user in slot ${request.params.slot}` });
      }
      try {
        const entry = deps.store.upsertUser(lockId, {
          slot,
          name: (request.body.name as string | undefined) ?? existing.name,
          // empty/omitted PIN keeps the stored PIN
          ...(request.body.pin !== undefined ? { pin: request.body.pin as string } : {}),
        });
        return reply.status(200).send({ user: userView(entry) });
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    },
  );

  app.delete<{ Params: { lockId: string; slot: string } }>(
    '/api/locks/:lockId/users/:slot',
    async (request, reply) => {
      const { lockId } = request.params;
      const slot = Number(request.params.slot);
      if (deps.store.getUser(lockId, slot) === undefined) {
        return reply.status(404).send({ error: `No user in slot ${request.params.slot}` });
      }
      const result = await deps.manager.clearUserPin(lockId, slot, actingUser(request.headers));
      if (!result.ok) {
        return reply.status(502).send({ error: result.error });
      }
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { lockId: string; slot: string }; Body: { targetLockIds?: unknown } }>(
    '/api/locks/:lockId/users/:slot/apply-pin',
    {
      schema: {
        body: {
          type: ['object', 'null'],
          properties: { targetLockIds: { type: 'array', items: { type: 'string' } } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { lockId } = request.params;
      const slot = Number(request.params.slot);
      const targetLockIds = (request.body?.targetLockIds as string[] | undefined) ?? [];
      try {
        const results: PinApplyResult[] = await deps.manager.applyUserPin(
          lockId,
          slot,
          targetLockIds,
          actingUser(request.headers),
        );
        return reply.status(200).send({ results });
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    },
  );

  // ------------------------------------------------------------- activity

  app.get<{ Querystring: { limit?: unknown; offset?: unknown; lockId?: unknown } }>(
    '/api/activity',
    async (request) => {
      const limit = Math.min(Math.max(Number(request.query.limit ?? 100) || 100, 1), 1000);
      const offset = Math.max(Number(request.query.offset ?? 0) || 0, 0);
      const lockId =
        typeof request.query.lockId === 'string' && request.query.lockId !== ''
          ? request.query.lockId
          : undefined;
      const { entries, total } = deps.store.getActivity(limit, offset, lockId);
      return { entries, total, limit, offset };
    },
  );

  // ------------------------------------------------------------- settings

  app.get('/api/settings', async () => ({
    notifyTarget: deps.manager.notifyTarget,
    notifyTargetOverride: deps.store.settings.notifyTarget ?? null,
    notificationsEnabled: deps.manager.notificationsEnabled,
    notificationsEnabledOverride: deps.store.settings.notificationsEnabled ?? null,
  }));

  app.put<{
    Body: { notifyTarget?: unknown; notificationsEnabled?: unknown };
  }>(
    '/api/settings',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            notifyTarget: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            notificationsEnabled: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      deps.manager.updateSettings({
        ...(request.body.notifyTarget !== undefined
          ? { notifyTarget: request.body.notifyTarget as string | null }
          : {}),
        ...(request.body.notificationsEnabled !== undefined
          ? { notificationsEnabled: request.body.notificationsEnabled as boolean | null }
          : {}),
      });
      return {
        notifyTarget: deps.manager.notifyTarget,
        notifyTargetOverride: deps.store.settings.notifyTarget ?? null,
        notificationsEnabled: deps.manager.notificationsEnabled,
        notificationsEnabledOverride: deps.store.settings.notificationsEnabled ?? null,
      };
    },
  );
}