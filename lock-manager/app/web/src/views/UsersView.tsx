import { useEffect, useState } from 'react';
import { api, type LockView, type UserView } from '../api.js';

function StatusBadge(props: { user: UserView }): React.JSX.Element {
  const { user } = props;
  if (!user.hasPin) {
    return <span className="badge muted-badge">no PIN</span>;
  }
  if (user.status === 'applied') {
    return <span className="badge ok">applied</span>;
  }
  if (user.status === 'failed') {
    return (
      <span className="badge error-badge" title={user.lastError ?? undefined}>
        failed
      </span>
    );
  }
  return <span className="badge warn">pending</span>;
}

export function UsersView(props: {
  locks: LockView[];
  selectedLockId: string | null;
  onSelectLock: (id: string) => void;
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const selected =
    props.locks.find((l) => l.id === props.selectedLockId) ?? props.locks[0] ?? null;
  const [users, setUsers] = useState<UserView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editSlot, setEditSlot] = useState<number | null>(null);
  const [applyTargets, setApplyTargets] = useState<{ slot: number; targets: string[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadUsers = async (): Promise<void> => {
    if (selected === null) {
      return;
    }
    try {
      const body = await api.users(selected.id);
      setUsers(body.users);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  useEffect(() => {
    setEditSlot(null);
    setApplyTargets(null);
    void loadUsers();
    const timer = setInterval(() => void loadUsers(), 10000);
    return () => clearInterval(timer);
  }, [selected?.id]);

  if (selected === null) {
    return <p className="muted">Manage a lock first (Locks tab).</p>;
  }

  const otherLocks = props.locks.filter((l) => l.id !== selected.id);

  const onApply = async (slot: number, targetLockIds: string[]): Promise<void> => {
    setError(null);
    setMessage(null);
    try {
      const body = await api.applyPin(selected.id, slot, targetLockIds);
      const failed = body.results.filter((r) => !r.ok);
      if (failed.length === 0) {
        const count = body.results.length;
        setMessage(
          count === 1
            ? 'PIN applied.'
            : `PIN applied to ${count} locks.`,
        );
      } else {
        setError(`Failed on ${failed.length} lock(s): ${failed.map((r) => r.error ?? 'error').join('; ')}`);
      }
      setApplyTargets(null);
      await loadUsers();
      await props.onChanged();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <section>
      {props.locks.length > 1 && (
        <label className="lock-picker">
          Lock:{' '}
          <select
            value={selected.id}
            onChange={(e) => props.onSelectLock(e.target.value)}
          >
            {props.locks.map((l) => (
              <option key={l.id} value={l.id}>
                {l.friendlyName}
              </option>
            ))}
          </select>
        </label>
      )}
      {error !== null && <div className="banner error-banner">{error}</div>}
      {message !== null && <div className="banner ok-banner">{message}</div>}

      <table className="table">
        <thead>
          <tr>
            <th>Slot</th>
            <th>Name</th>
            <th>PIN status</th>
            <th className="right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) =>
            editSlot === user.slot ? (
              <EditRow
                key={user.slot}
                user={user}
                onCancel={() => setEditSlot(null)}
                onSaved={async () => {
                  setEditSlot(null);
                  await loadUsers();
                }}
                lockId={selected.id}
              />
            ) : (
              <tr key={user.slot}>
                <td>{user.slot}</td>
                <td>{user.name}</td>
                <td>
                  <StatusBadge user={user} />
                  {user.status === 'failed' && user.lastError !== undefined && (
                    <span className="muted error-detail"> {user.lastError}</span>
                  )}
                </td>
                <td className="right">
                  <button
                    className="secondary"
                    disabled={!user.hasPin}
                    onClick={() => setApplyTargets({ slot: user.slot, targets: [] })}
                  >
                    Apply…
                  </button>{' '}
                  <button className="secondary" onClick={() => setEditSlot(user.slot)}>
                    Edit
                  </button>{' '}
                  <DeleteButton lockId={selected.id} user={user} onDeleted={loadUsers} />
                </td>
              </tr>
            ),
          )}
          {users.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No users yet — add one below.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <AddUserForm lockId={selected.id} onAdded={loadUsers} />

      {applyTargets !== null && (
        <ApplyDialog
          user={users.find((u) => u.slot === applyTargets.slot) as UserView}
          sourceLock={selected}
          otherLocks={otherLocks}
          initialTargets={applyTargets.targets}
          onClose={() => setApplyTargets(null)}
          onApply={(targets) => onApply(applyTargets.slot, targets)}
        />
      )}
    </section>
  );
}

function DeleteButton(props: {
  lockId: string;
  user: UserView;
  onDeleted: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const onClick = async (): Promise<void> => {
    const hint = props.user.hasPin
      ? `Remove "${props.user.name}" (slot ${props.user.slot})?\n\nThe PIN is cleared on the lock and the entry is removed.`
      : `Remove "${props.user.name}" (slot ${props.user.slot})?\n\nA clear command is sent to the lock for this slot.`;
    if (!window.confirm(hint)) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteUser(props.lockId, props.user.slot);
      await props.onDeleted();
    } catch (err) {
      window.alert(`Could not remove: ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="danger" disabled={busy} onClick={() => void onClick()}>
      Delete
    </button>
  );
}

function AddUserForm(props: { lockId: string; onAdded: () => Promise<void> }): React.JSX.Element {
  const [slot, setSlot] = useState('');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    try {
      await api.createUser(props.lockId, {
        slot: Number(slot),
        name,
        ...(pin !== '' ? { pin } : {}),
      });
      setSlot('');
      setName('');
      setPin('');
      await props.onAdded();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <form className="card form" onSubmit={(e) => void submit(e)}>
      <h3>Add user</h3>
      {error !== null && <div className="banner error-banner">{error}</div>}
      <div className="form-row">
        <label>
          Slot
          <input
            type="number"
            min={0}
            required
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            placeholder="e.g. 1"
          />
        </label>
        <label>
          Name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alice"
          />
        </label>
        <label>
          PIN <span className="muted">(optional)</span>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            minLength={4}
            maxLength={12}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="leave empty for none"
            autoComplete="off"
          />
        </label>
        <button type="submit">Add</button>
      </div>
    </form>
  );
}

function EditRow(props: {
  user: UserView;
  lockId: string;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState(props.user.name);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setError(null);
    try {
      await api.updateUser(props.lockId, props.user.slot, {
        name,
        ...(pin !== '' ? { pin } : {}),
      });
      await props.onSaved();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  return (
    <tr className="edit-row">
      <td>{props.user.slot}</td>
      <td>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td colSpan={2}>
        <input
          className="pin-input"
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          minLength={4}
          maxLength={12}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder={props.user.hasPin ? 'leave empty to keep' : 'set PIN (optional)'}
          autoComplete="off"
        />{' '}
        <button onClick={() => void save()}>Save</button>{' '}
        <button className="secondary" onClick={props.onCancel}>
          Cancel
        </button>
        {error !== null && <div className="banner error-banner">{error}</div>}
      </td>
    </tr>
  );
}

function ApplyDialog(props: {
  user: UserView;
  sourceLock: LockView;
  otherLocks: LockView[];
  initialTargets: string[];
  onClose: () => void;
  onApply: (targets: string[]) => Promise<void>;
}): React.JSX.Element {
  const [targets, setTargets] = useState(new Set(props.initialTargets));

  const toggle = (id: string): void => {
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div className="dialog card" onClick={(e) => e.stopPropagation()}>
        <h3>Apply PIN — {props.user.name} (slot {props.user.slot})</h3>
        <p className="muted">
          Writes the stored PIN to <strong>{props.sourceLock.friendlyName}</strong>
          {targets.size > 0 ? ' and the selected locks' : ''}.
        </p>
        {props.otherLocks.length > 0 && (
          <>
            <p>Also apply to:</p>
            {props.otherLocks.map((l) => (
              <label key={l.id} className="check-row">
                <input
                  type="checkbox"
                  checked={targets.has(l.id)}
                  onChange={() => toggle(l.id)}
                />{' '}
                {l.friendlyName}
              </label>
            ))}
          </>
        )}
        <div className="dialog-actions">
          <button className="secondary" onClick={props.onClose}>
            Cancel
          </button>
          <button onClick={() => void props.onApply([...targets])}>Apply</button>
        </div>
      </div>
    </div>
  );
}