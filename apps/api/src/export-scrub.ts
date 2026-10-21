function isSensitiveExportKey(key: string): boolean {
  const normalized = key.replaceAll(/[_-]/g, '').toLowerCase();
  return /(?:token|secret|cookie|credential|password|authorization)$/.test(normalized)
    || normalized === 'key'
    || /(?:api|encryption|private|signing|backup|session|secret|recovery)key$/.test(normalized);
}

/** Remove credentials while retaining application data whose names happen to contain “session”. */
export function scrubExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubExport);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !isSensitiveExportKey(key)).map(([key, item]) => [key, scrubExport(item)]));
  }
  return value;
}
