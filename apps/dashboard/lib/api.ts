import { currentLocale, localizedError } from './i18n';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code: string, public detail?: string) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; detail?: string };
    const code = payload.error ?? 'UNKNOWN';
    throw new ApiError(localizedError(code, currentLocale()), response.status, code, payload.detail);
  }
  return response.json() as Promise<T>;
}

export const errorMessage = (error: unknown) => {
  if (error instanceof ApiError) return error.message;
  // fetch() rejects with a TypeError when the local API is unreachable; never show the raw browser text.
  if (error instanceof TypeError) return localizedError('NETWORK_UNAVAILABLE', currentLocale());
  return localizedError('UNKNOWN', currentLocale());
};
export const formatDate = (value?: string | null) => value ? new Intl.DateTimeFormat(currentLocale() === 'en' ? 'en-GB' : 'es-ES', { dateStyle: 'medium' }).format(new Date(value)) : currentLocale() === 'en' ? 'No date' : 'Sin fecha';
