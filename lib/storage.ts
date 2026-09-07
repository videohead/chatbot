import path from "node:path";

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/data/uploads";

const STORED_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Resolves a stored upload name to an absolute path, rejecting traversal attempts.
 * Returns null when the name is not a plain file inside UPLOAD_DIR.
 */
export function resolveUploadPath(storedName: string): string | null {
  if (!STORED_NAME_PATTERN.test(storedName) || storedName.includes("..")) {
    return null;
  }

  const resolved = path.resolve(UPLOAD_DIR, storedName);

  if (path.dirname(resolved) !== path.resolve(UPLOAD_DIR)) {
    return null;
  }

  return resolved;
}
