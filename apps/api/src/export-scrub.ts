const exactSensitiveKeys = new Set([
  'key', 'apikey', 'xapikey', 'encryptionkey', 'privatekey', 'signingkey', 'backupkey', 'sessionkey', 'secretkey', 'recoverykey',
]);

function isSensitiveExportKey(key: string): boolean {
  const normalized = key.replaceAll(/[_-]/g, '').toLowerCase();
  return /(?:token|secret|cookie|credential|password|authorization)$/.test(normalized) || exactSensitiveKeys.has(normalized);
}

/** Remove credentials while retaining application data whose names happen to contain “session”. */
export function scrubExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubExport);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !isSensitiveExportKey(key)).map(([key, item]) => [key, scrubExport(item)]));
  }
  return value;
}
