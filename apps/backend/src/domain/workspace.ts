import { statSync } from 'node:fs';
import { basename, isAbsolute, normalize } from 'node:path';
import { InvalidInputError } from './errors.ts';

/** Validates a configured workspace path. Error messages never echo the path. */
export function validateWorkspacePath(raw: string): string {
  if (!isAbsolute(raw)) throw new InvalidInputError('workspace must be an absolute path');
  if (raw.split(/[\\/]/).includes('..')) throw new InvalidInputError('workspace must not contain ".." segments');
  const path = normalize(raw).replace(/(.)[\\/]+$/, '$1');
  let ok = false;
  try {
    ok = statSync(path).isDirectory();
  } catch {
    throw new InvalidInputError('workspace directory does not exist');
  }
  if (!ok) throw new InvalidInputError('workspace must be a directory');
  return path;
}

export const workspaceLabel = (path: string) => basename(path) || '/';
