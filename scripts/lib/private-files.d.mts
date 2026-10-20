export function ensurePrivateDir(path: string): Promise<string>;
export function ensurePrivateFile(path: string, options?: { create?: boolean }): Promise<string>;
