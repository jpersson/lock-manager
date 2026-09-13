import { useEffect, useState } from 'react';
import { api, type SettingsView } from '../api.js';

export function SettingsView(): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [notifyTarget, setNotifyTarget] = useState('');
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const body = await api.settings();
    setSettings(body);
    setNotifyTarget(body.notifyTarget);
    setNotificationsEnabled(body.notificationsEnabled);
  };

  useEffect(() => {
    void load();
  }, []);

  if (settings === null) {
    return <p className="muted">Loading…</p>;
  }

  const save = async (): Promise<void> => {
    setError(null);
    setMessage(null);
    try {
      const body = await api.saveSettings({
        notifyTarget: notifyTarget.trim() === '' ? null : notifyTarget.trim(),
        // Keep the current override state for the toggle (three-state via buttons).
        ...(settings.notificationsEnabledOverride === null
          ? { notificationsEnabled: notificationsEnabled !== settings.notificationsEnabled ? notificationsEnabled : null }
          : {}),
      });
      setSettings(body);
      setNotifyTarget(body.notifyTarget);
      setNotificationsEnabled(body.notificationsEnabled);
      setMessage('Settings saved.');
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const resetNotifyTarget = async (): Promise<void> => {
    setError(null);
    try {
      const body = await api.saveSettings({ notifyTarget: null });
      setSettings(body);
      setNotifyTarget(body.notifyTarget);
      setMessage('Notify target reset to the add-on configuration.');
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const resetToggle = async (): Promise<void> => {
    setError(null);
    try {
      const body = await api.saveSettings({ notificationsEnabled: null });
      setSettings(body);
      setNotificationsEnabled(body.notificationsEnabled);
      setMessage('Notification toggle reset to the add-on configuration.');
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const toggle = async (): Promise<void> => {
    setError(null);
    try {
      const next = !notificationsEnabled;
      const body = await api.saveSettings({ notificationsEnabled: next });
      setSettings(body);
      setNotificationsEnabled(next);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <section>
      <h2>Settings</h2>
      {error !== null && <div className="banner error-banner">{error}</div>}
      {message !== null && <div className="banner ok-banner">{message}</div>}
      <div className="card form">
        <h3>Notifications</h3>
        <div className="form-row">
          <label>
            Notify target
            <input
              value={notifyTarget}
              onChange={(e) => setNotifyTarget(e.target.value)}
              placeholder="notify.notify"
            />
          </label>
          <button onClick={() => void save()}>Save</button>
          {settings.notifyTargetOverride !== null && (
            <button className="secondary" onClick={() => void resetNotifyTarget()}>
              Reset to add-on config
            </button>
          )}
        </div>
        {settings.notifyTargetOverride !== null && (
          <p className="muted">
            Overridden in-app; the add-on configuration default would be used after a reset.
          </p>
        )}

        <label className="check-row">
          <input type="checkbox" checked={notificationsEnabled} onChange={() => void toggle()} />
          Send a notification when a recognized user locks/unlocks via keypad
        </label>
        {settings.notificationsEnabledOverride !== null && (
          <p className="muted">
            Overridden in-app.{' '}
            <button className="link" onClick={() => void resetToggle()}>
              Reset to add-on config
            </button>
          </p>
        )}
      </div>
    </section>
  );
}