import { useCallback, useEffect, useState } from 'react';
import { formatTime } from './format';
import { loadSettings, saveSettings } from './storage';
import type { Settings } from './settings';
import { useGateway } from './useGateway';
import { Agents } from './views/Agents';
import { Gateway } from './views/Gateway';
import { Health } from './views/Health';
import { Overview } from './views/Overview';
import { SettingsView } from './views/SettingsView';

const ROUTES = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'AI Agents' },
  { id: 'gateway', label: 'MCP Gateway' },
  { id: 'health', label: 'System Health' },
  { id: 'settings', label: 'Settings' },
] as const;

type RouteId = (typeof ROUTES)[number]['id'];

function readRoute(): RouteId {
  const id = window.location.hash.replace(/^#\/?/, '');
  return ROUTES.find((route) => route.id === id)?.id ?? 'overview';
}

function useRoute(): RouteId {
  const [route, setRoute] = useState<RouteId>(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const { snapshot, refresh } = useGateway(settings);

  const save = useCallback((next: Settings) => {
    setSettings(next);
    return saveSettings(next);
  }, []);

  const title = ROUTES.find((candidate) => candidate.id === route)?.label ?? 'Overview';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icon.svg" alt="" width={32} height={32} />
          <div>
            <strong>AI Roblox Player</strong>
            <span>Phase 1 · Gateway foundation</span>
          </div>
        </div>
        <nav aria-label="Sections">
          {ROUTES.map((item) => (
            <a
              key={item.id}
              href={`#/${item.id}`}
              className={item.id === route ? 'nav-link active' : 'nav-link'}
              aria-current={item.id === route ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <div className="topbar-actions">
            {snapshot.refreshedAt !== undefined && (
              <span className="muted small">Updated {formatTime(snapshot.refreshedAt)}</span>
            )}
            <button type="button" className="button button-quiet" onClick={refresh}>
              Refresh
            </button>
          </div>
        </header>

        {route === 'overview' && <Overview snapshot={snapshot} />}
        {route === 'agents' && <Agents snapshot={snapshot} />}
        {route === 'gateway' && <Gateway snapshot={snapshot} baseUrl={settings.baseUrl} />}
        {route === 'health' && <Health snapshot={snapshot} />}
        {route === 'settings' && <SettingsView settings={settings} onSave={save} />}
      </main>
    </div>
  );
}
