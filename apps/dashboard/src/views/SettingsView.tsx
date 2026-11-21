import { useState, type FormEvent } from 'react';
import { Card, Notice } from '../components';
import { REFRESH_CHOICES, normalizeBaseUrl, parseRefreshSeconds, type Settings } from '../settings';

export function SettingsView({
  settings,
  onSave,
}: {
  settings: Settings;
  onSave: (next: Settings) => boolean;
}) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [token, setToken] = useState(settings.token);
  const [refreshSeconds, setRefreshSeconds] = useState(String(settings.refreshSeconds));
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger' | 'warn'; text: string } | undefined>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeBaseUrl(baseUrl);
    if (normalized === undefined) {
      setMessage({ tone: 'danger', text: 'The gateway URL must start with http:// or https://.' });
      return;
    }
    const saved = onSave({
      baseUrl: normalized,
      token: token.trim(),
      refreshSeconds: parseRefreshSeconds(refreshSeconds),
    });
    setBaseUrl(normalized);
    setMessage(
      saved
        ? { tone: 'ok', text: 'Settings saved.' }
        : { tone: 'warn', text: 'Applied for this visit only: browser storage is unavailable.' },
    );
  }

  return (
    <form className="stack narrow" onSubmit={submit}>
      <Card title="Gateway connection">
        <label className="field">
          <span>Gateway URL</span>
          <input
            type="url"
            inputMode="url"
            placeholder="Same origin"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <small>
            Leave empty when the dashboard and gateway share an origin, or when using the dev proxy. A
            dashboard served over HTTPS cannot call a gateway over plain HTTP.
          </small>
        </label>

        <label className="field">
          <span>Admin token</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <small>
            Kept in this tab's session storage and cleared when the tab closes. It is never sent anywhere
            except the gateway URL above.
          </small>
        </label>

        <label className="field">
          <span>Refresh interval</span>
          <select value={refreshSeconds} onChange={(event) => setRefreshSeconds(event.target.value)}>
            {REFRESH_CHOICES.map((seconds) => (
              <option key={seconds} value={seconds}>
                Every {seconds} seconds
              </option>
            ))}
          </select>
        </label>
      </Card>

      {message !== undefined && (
        <Notice tone={message.tone} title={message.tone === 'ok' ? 'Saved' : 'Check the form'}>
          {message.text}
        </Notice>
      )}

      <div>
        <button type="submit" className="button">
          Save settings
        </button>
      </div>
    </form>
  );
}
