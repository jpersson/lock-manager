import { useEffect, useState } from 'react';
import { api } from './api.js';
import { ActivityView } from './views/ActivityView.js';
import { LocksView } from './views/LocksView.js';
import { SettingsView } from './views/SettingsView.js';
import { UsersView } from './views/UsersView.js';

export type Tab = 'locks' | 'users' | 'activity' | 'settings';

export function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('locks');
  const [error, setError] = useState<string | null>(null);

  const [locks, setLocks] = useState<Awaited<ReturnType<typeof api.locks>>['locks']>([]);
  const [selectedLockId, setSelectedLockId] = useState<string | null>(null);

  const refreshLocks = async (): Promise<void> => {
    try {
      const body = await api.locks();
      setLocks(body.locks);
      setSelectedLockId((prev) => {
        const managed = body.locks.filter((l) => l.managed);
        if (prev !== null && managed.some((l) => l.id === prev)) {
          return prev;
        }
        return managed[0]?.id ?? null;
      });
      setError(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  useEffect(() => {
    void refreshLocks();
    const timer = setInterval(() => {
      void refreshLocks();
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  const managed = locks.filter((l) => l.managed);
  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: 'locks', label: 'Locks', show: true },
    { id: 'users', label: 'Users', show: managed.length > 0 },
    { id: 'activity', label: 'Activity', show: managed.length > 0 },
    { id: 'settings', label: 'Settings', show: true },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <span className="title">
          <span className="icon">🔒</span> Lock Manager
        </span>
        {error !== null && <span className="error-banner">{error}</span>}
      </header>
      <nav className="tabs">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
      </nav>
      <main>
        {tab === 'locks' && <LocksView locks={locks} onChanged={refreshLocks} />}
        {tab === 'users' && (
          <UsersView
            locks={managed}
            selectedLockId={selectedLockId}
            onSelectLock={setSelectedLockId}
            onChanged={refreshLocks}
          />
        )}
        {tab === 'activity' && <ActivityView locks={managed} />}
        {tab === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}