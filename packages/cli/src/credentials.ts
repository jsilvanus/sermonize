/**
 * The token saved by `sermonize-admin login`: $XDG_CONFIG_HOME/sermonize/credentials.json
 * (default ~/.config/sermonize/credentials.json), directory 0700, file 0600.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Credentials {
  api_url: string;
  token: string;
  expires_at: string;
  user_id: string;
  role: string;
  email: string;
}

export function credentialsPath(env: Record<string, string | undefined>): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'sermonize', 'credentials.json');
}

export async function loadCredentials(path: string): Promise<Credentials | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const data = JSON.parse(text) as Partial<Credentials>;
    if (typeof data.api_url !== 'string' || typeof data.token !== 'string') return null;
    return data as Credentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(path: string, creds: Credentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // `mode` applies only when the file is created; chmod covers an existing file.
  await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function deleteCredentials(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
