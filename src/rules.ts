import { applyExtraRules } from './rules-extra.js';
import type { ToolCall, Verdict } from './types.js';

const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS']);

/** JSON with object keys sorted at every depth, so equal inputs compare equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A pure-JS equivalent of Node's `path.posix.normalize`: resolves `.` and
 * `..` segments and collapses repeated slashes. Kept dependency-free (no
 * `node:path`) because this runs inside the hooks module's sandbox, which
 * has no Node built-ins.
 */
function posixNormalize(p: string): string {
  if (p.length === 0) return '.';
  const isAbsolute = p.charCodeAt(0) === 47; // '/'
  const trailingSlash = p.charCodeAt(p.length - 1) === 47 && p.length > 1;
  const resolved: string[] = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') resolved.pop();
      else if (!isAbsolute) resolved.push('..');
    } else {
      resolved.push(segment);
    }
  }
  let result = resolved.join('/');
  if (isAbsolute) result = `/${result}`;
  if (result.length === 0) result = isAbsolute ? '/' : '.';
  if (trailingSlash && !result.endsWith('/')) result += '/';
  return result;
}

export function normalizePath(p: string): string {
  const normalized = posixNormalize(p);
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const p = input['file_path'] ?? input['notebook_path'];
  return typeof p === 'string' && p.length > 0 ? normalizePath(p) : undefined;
}

function isRanged(input: Record<string, unknown>): boolean {
  return (input['offset'] ?? null) !== null || (input['limit'] ?? null) !== null;
}

/**
 * Whether a call proves that earlier reads of its path are out of date: a
 * successful write, or a successful full (unranged) read. A failed write
 * changed nothing, and a ranged read may cover none of what an earlier one did.
 */
function supersedesReads(call: ToolCall): boolean {
  if (call.isError) return false;
  if (WRITE_TOOLS.has(call.tool)) return true;
  return READ_TOOLS.has(call.tool) && !isRanged(call.input);
}

/**
 * Deterministic staleness verdicts. Scans newest to oldest, remembering what
 * later calls did, so each call is judged against everything after it. Pinned
 * calls count as evidence but are never targets.
 */
export function applyRules(calls: readonly ToolCall[]): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();
  const pathsTouchedLater = new Set<string>();
  const searchesLater = new Set<string>();
  const successesLater = new Set<string>();

  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]!;
    const key = `${call.tool}:${canonicalJson(call.input)}`;
    const path = pathOf(call.input);

    if (!call.pinned) {
      if (call.isError && successesLater.has(key)) {
        verdicts.set(call.id, { action: 'drop_call', source: 'rule', rule: 'failed_then_fixed' });
      } else if (SEARCH_TOOLS.has(call.tool) && searchesLater.has(key)) {
        verdicts.set(call.id, { action: 'drop_call', source: 'rule', rule: 'repeated_search' });
      } else if (READ_TOOLS.has(call.tool) && path && pathsTouchedLater.has(path)) {
        verdicts.set(call.id, { action: 'drop_result', source: 'rule', rule: 'stale_read' });
      }
    }

    if (!call.isError) successesLater.add(key);
    if (SEARCH_TOOLS.has(call.tool)) searchesLater.add(key);
    if (path && supersedesReads(call)) pathsTouchedLater.add(path);
  }
  return applyExtraRules(calls, verdicts);
}
