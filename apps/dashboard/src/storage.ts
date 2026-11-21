import { DEFAULT_REFRESH_SECONDS, normalizeBaseUrl, parseRefreshSeconds, type Settings } from './settings';

const PREFERENCES_KEY = 'arp.preferences';
const TOKEN_KEY = 'arp.adminToken';

function readJson(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Storage can be unavailable (private mode, blocked cookies); the dashboard then runs on defaults. */
function safely<T>(action: () => T, fallback: T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}

export function loadSettings(): Settings {
  const preferences = safely(() => readJson(localStorage.getItem(PREFERENCES_KEY)), {});
  const savedUrl = typeof preferences.baseUrl === 'string' ? normalizeBaseUrl(preferences.baseUrl) : undefined;
  const defaultUrl = normalizeBaseUrl(import.meta.env.VITE_GATEWAY_URL ?? '') ?? '';

  return {
    baseUrl: savedUrl ?? defaultUrl,
    token: safely(() => sessionStorage.getItem(TOKEN_KEY) ?? '', ''),
    refreshSeconds: parseRefreshSeconds(preferences.refreshSeconds ?? DEFAULT_REFRESH_SECONDS),
  };
}

/** The admin token goes to sessionStorage only, so it is gone when the tab closes. */
export function saveSettings(settings: Settings): boolean {
  return safely(() => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ baseUrl: settings.baseUrl, refreshSeconds: settings.refreshSeconds }),
    );
    if (settings.token === '') sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, settings.token);
    return true;
  }, false);
}
