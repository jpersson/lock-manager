import { api, type LockView } from '../api.js';

export function LocksView(props: {
  locks: LockView[];
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const managed = props.locks.filter((l) => l.managed);
  const unmanaged = props.locks.filter((l) => !l.managed);

  const manage = async (id: string): Promise<void> => {
    await api.manageLock(id);
    await props.onChanged();
  };

  const unmanage = async (lock: LockView): Promise<void> => {
    const ok = window.confirm(
      `Stop managing "${lock.friendlyName}"?\n\nUser entries for this lock are removed from Lock Manager. ` +
        'PINs already programmed on the lock stay on the lock.',
    );
    if (!ok) {
      return;
    }
    await api.unmanageLock(lock.id);
    await props.onChanged();
  };

  const empty = managed.length === 0 && unmanaged.length === 0 ? (
    <p className="muted">
      No Zigbee2MQTT locks found yet. Locks appear here automatically once
      Zigbee2MQTT reports them (they must support PIN codes).
    </p>
  ) : null;

  return (
    <section>
      {empty}
      {managed.length > 0 && (
        <>
          <h2>Managed locks</h2>
          <div className="card-list">
            {managed.map((lock) => (
              <div key={lock.id} className="card row">
                <div>
                  <span className="lock-name">{lock.friendlyName}</span>
                  <span className="muted">
                    {' '}
                    {lock.vendor ?? ''} {lock.model ?? ''}
                  </span>
                  {!lock.discovered && <span className="badge warn">offline</span>}
                </div>
                <button className="secondary" onClick={() => void unmanage(lock)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {unmanaged.length > 0 && (
        <>
          <h2>Discovered locks</h2>
          <div className="card-list">
            {unmanaged.map((lock) => (
              <div key={lock.id} className="card row">
                <div>
                  <span className="lock-name">{lock.friendlyName}</span>
                  <span className="muted">
                    {' '}
                    {lock.vendor ?? ''} {lock.model ?? ''}
                  </span>
                </div>
                <button onClick={() => void manage(lock.id)}>Manage</button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}