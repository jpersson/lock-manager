import { useEffect, useState } from 'react';

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<string>('connecting…');

  useEffect(() => {
    // Relative URL only: the app is served behind HA Ingress at an unknown path.
    fetch('./api/status')
      .then((res) => res.json() as Promise<{ status: string }>)
      .then((body) => setStatus(body.status))
      .catch(() => setStatus('unreachable'));
  }, []);

  return (
    <main className="placeholder">
      <h1>Lock Manager</h1>
      <p>API status: {status}</p>
      <p className="muted">The management UI is being built (plan step 9).</p>
    </main>
  );
}