/**
 * Small helpers shared by the knowledge + content command groups (documents,
 * notebooks, podcasts, media, entities, creative-*, production, widgets, …).
 * Leaf module: errors + io + node:fs only.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { Ctx } from '../context.js';
import { CliError } from '../errors.js';
import { formatTable, writeJson, writeLine } from '../io.js';

/** Parse `--body <json>` / `--body-file <path>` into an object (or undefined when neither given). */
export function readBodyOption(ctx: Ctx, options: Record<string, any>): Record<string, any> | undefined {
  let raw: string | undefined;
  if (options.bodyFile) {
    try {
      raw = readFileSync(resolvePath(ctx.cwd, String(options.bodyFile)), 'utf8');
    } catch (err) {
      throw new CliError(`Cannot read --body-file ${String(options.bodyFile)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (options.body !== undefined) {
    raw = String(options.body);
  }
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`${options.bodyFile ? '--body-file' : '--body'} must be valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`${options.bodyFile ? '--body-file' : '--body'} must be a JSON object`);
  }
  return parsed as Record<string, any>;
}

/** Merge a `--body`/`--body-file` object under explicit flag fields (flags win). */
export function mergeBody(ctx: Ctx, options: Record<string, any>, fields: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = { ...(readBodyOption(ctx, options) ?? {}) };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
}

/** Parse a JSON flag value (array/object/scalar); throws a legible usage error. */
export function parseJsonFlag(flag: string, value: unknown): any {
  try {
    return JSON.parse(String(value));
  } catch {
    throw new CliError(`${flag} must be valid JSON`);
  }
}

/** Comma-split a flag value into a trimmed, non-empty list. */
export function csv(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Render a list response: JSON under --json, otherwise a table (or an empty line). */
export function renderList(ctx: Ctx, body: any, items: any[], columns: string[], empty: string, project?: (row: any) => Record<string, unknown>): number {
  if (ctx.json) { writeJson(ctx.io.stdout, body); return 0; }
  if (!Array.isArray(items) || items.length === 0) { writeLine(ctx.io.stdout, empty); return 0; }
  const rows = items.map((r) => project ? project(r) : Object.fromEntries(columns.map((c) => [c, scalar(r?.[c])])));
  writeLine(ctx.io.stdout, formatTable(rows, columns));
  return 0;
}

/** Render a mutation result: JSON under --json, otherwise a one-line message. */
export function renderDone(ctx: Ctx, body: any, message: string): number {
  if (ctx.json) writeJson(ctx.io.stdout, body);
  else writeLine(ctx.io.stdout, message);
  return 0;
}

/** First array found among `keys` on `body` (or `body` itself when it is an array). */
export function pickArray(body: any, ...keys: string[]): any[] {
  if (Array.isArray(body)) return body;
  for (const k of keys) if (Array.isArray(body?.[k])) return body[k];
  return [];
}

function scalar(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** URL-encode one path segment. */
export const enc = (s: unknown) => encodeURIComponent(String(s));

/** Append a query string built from defined values. */
export function withQuery(path: string, query: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}
