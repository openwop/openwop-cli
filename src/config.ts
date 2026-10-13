/** CLI config file (~/.openwop/config.json) + dotted-path helpers + home dir. */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.js';

/** Path to the config file for a profile (OPENWOP_CONFIG_HOME overrides the parent). */
export function configPathFor(profile: string | undefined, env = process.env): string {
  const home = env.OPENWOP_CONFIG_HOME ?? homedir();
  const dir = profile ? `.openwop-${profile}` : '.openwop';
  return join(home, dir, 'config.json');
}

export function readConfigSafe(path: string): any {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function saveConfig(path: string, config: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  try { chmodSync(path, 0o600); } catch { /* best-effort on Windows */ }
}

export function mergeConfig(existing: any, next: any): any {
  const base = existing ?? {};
  return {
    ...base,
    ...next,
    host: { ...(base.host ?? {}), ...(next.host ?? {}) },
  };
}

export function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * Segments that would walk off the config object onto a prototype
 * (`__proto__.x`, `constructor.prototype.x`) and pollute every object.
 */
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function safePathParts(path: string): string[] {
  const parts = path.split('.');
  for (const part of parts) {
    if (UNSAFE_PATH_SEGMENTS.has(part)) throw new CliError(`Config key segment '${part}' is not allowed: ${path}`);
  }
  return parts;
}

export function setByPath(obj: any, path: string, value: unknown): void {
  const parts = safePathParts(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!Object.hasOwn(cur, key) || typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

export function unsetByPath(obj: any, path: string): void {
  const parts = safePathParts(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!Object.hasOwn(cur, key) || typeof cur[key] !== 'object' || cur[key] === null) return;
    cur = cur[key];
  }
  delete cur[parts[parts.length - 1]];
}

/** Root state dir (~/.openwop or OPENWOP_CONFIG_HOME/.openwop) for pids, logs, creds. */
export function openwopHomeDir(env = process.env): string {
  const home = env.OPENWOP_CONFIG_HOME ?? homedir();
  return join(home, '.openwop');
}
