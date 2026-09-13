export interface UserView {
  slot: number;
  name: string;
  hasPin: boolean;
  status?: 'pending' | 'applied' | 'failed';
  lastAppliedAt?: string;
  lastError?: string;
}

export interface LockView {
  id: string;
  friendlyName: string;
  model?: string;
  vendor?: string;
  managed: boolean;
  discovered: boolean;
  users?: UserView[];
}

export interface ActivityView {
  ts: string;
  lockId: string;
  lockName: string;
  type: string;
  action?: string;
  source?: string;
  slot?: number;
  userName?: string;
  detail?: string;
  byUser?: string;
}

export interface StatusView {
  status: string;
  version: string;
  mqtt: string;
  baseTopic: string;
  notifyTarget: string;
  notificationsEnabled: boolean;
}

export interface SettingsView {
  notifyTarget: string;
  notifyTargetOverride: string | null;
  notificationsEnabled: boolean;
  notificationsEnabledOverride: boolean | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (res.status === 204) {
    return undefined as T;
  }
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body;
}

// All URLs are relative: the app is served behind HA Ingress at an unknown path.
export const api = {
  status: () => request<StatusView>('api/status'),
  locks: () => request<{ locks: LockView[] }>('api/locks'),
  manageLock: (lockId: string) =>
    request<{ lock: LockView }>('api/locks', { method: 'POST', body: JSON.stringify({ lockId }) }),
  unmanageLock: (lockId: string) => request<void>(`api/locks/${lockId}`, { method: 'DELETE' }),

  users: (lockId: string) => request<{ users: UserView[] }>(`api/locks/${lockId}/users`),
  createUser: (lockId: string, body: { slot: number; name: string; pin?: string }) =>
    request<{ user: UserView }>(`api/locks/${lockId}/users`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateUser: (lockId: string, slot: number, body: { name: string; pin?: string }) =>
    request<{ user: UserView }>(`api/locks/${lockId}/users/${slot}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteUser: (lockId: string, slot: number) =>
    request<void>(`api/locks/${lockId}/users/${slot}`, { method: 'DELETE' }),
  applyPin: (lockId: string, slot: number, targetLockIds: string[]) =>
    request<{ results: Array<{ lockId: string; ok: boolean; error?: string }> }>(
      `api/locks/${lockId}/users/${slot}/apply-pin`,
      { method: 'POST', body: JSON.stringify({ targetLockIds }) },
    ),

  activity: (lockId?: string) =>
    request<{ entries: ActivityView[]; total: number }>(lockId ? `api/activity?lockId=${lockId}` : 'api/activity'),
  settings: () => request<SettingsView>('api/settings'),
  saveSettings: (body: { notifyTarget?: string | null; notificationsEnabled?: boolean | null }) =>
    request<SettingsView>('api/settings', { method: 'PUT', body: JSON.stringify(body) }),
};