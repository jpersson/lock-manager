import { useEffect, useState } from 'react';
import { api, type ActivityView, type LockView } from '../api.js';

const TYPE_LABELS: Record<string, string> = {
  'keypad-unlock': 'Keypad unlock',
  'keypad-lock': 'Keypad lock',
  'keypad-failure': 'Keypad failure',
  manual: 'Manual',
  other: 'Other',
  'pin-apply': 'PIN applied',
  'pin-clear': 'PIN cleared',
  'pin-failed': 'PIN write failed',
  'notify-failed': 'Notification failed',
  system: 'System',
};

function describe(entry: ActivityView): string {
  switch (entry.type) {
    case 'keypad-unlock':
    case 'keypad-lock': {
      const who = entry.userName ?? `Unknown user (slot ${entry.slot ?? '?'})`;
      return `${who} ${entry.type === 'keypad-unlock' ? 'unlocked' : 'locked'} ${entry.lockName}`;
    }
    case 'keypad-failure':
      return `${entry.userName ?? `Unknown user (slot ${entry.slot ?? '?'})`} failed (${entry.action ?? 'failure'}) on ${entry.lockName}`;
    case 'manual':
      return `${entry.action ?? 'manual operation'} on ${entry.lockName}`;
    case 'other':
      return `${entry.action ?? 'event'}${entry.source ? ` via ${entry.source}` : ''} on ${entry.lockName}`;
    case 'pin-apply':
    case 'pin-clear':
    case 'pin-failed':
      return `${TYPE_LABELS[entry.type] ?? entry.type}: ${entry.userName ?? `slot ${entry.slot ?? ''}`} on ${entry.lockName}${entry.detail ? ` — ${entry.detail}` : ''}${entry.byUser ? ` (by ${entry.byUser})` : ''}`;
    default:
      return `${TYPE_LABELS[entry.type] ?? entry.type} ${entry.detail ?? ''}`.trim();
  }
}

export function ActivityView(props: { locks: LockView[] }): React.JSX.Element {
  const [entries, setEntries] = useState<ActivityView[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const body = await api.activity(filter === '' ? undefined : filter);
      setEntries(body.entries);
      setTotal(body.total);
      setError(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [filter]);

  return (
    <section>
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Activity</h2>
        <label>
          Lock:{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All</option>
            {props.locks.map((l) => (
              <option key={l.id} value={l.id}>
                {l.friendlyName}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error !== null && <div className="banner error-banner">{error}</div>}
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.ts}-${i}`}>
              <td className="muted nowrap">{new Date(e.ts).toLocaleString()}</td>
              <td>{describe(e)}</td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={2} className="muted">
                No activity yet. Keypad lock/unlock events appear here in real time.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted">{total} events kept (90-day retention).</p>
    </section>
  );
}