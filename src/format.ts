/**
 * Shared formatting helpers for consistent count phrasing (AXI house style §4).
 *
 * Standard phrases:
 *   count: N                       — simple count
 *   count: N of T total            — when the true total is known
 *   count: N (showing first N)     — when truncated by the request limit
 */

export interface CountLineOptions {
  /** Number of items returned / displayed. */
  count: number;
  /** The request limit; when count === limit, results may be truncated. */
  limit?: number;
  /** True total count (matches before the limit was applied). */
  totalCount?: number;
}

export function formatCountLine(opts: CountLineOptions): string {
  const { count, limit, totalCount } = opts;

  if (totalCount !== undefined && totalCount !== null && totalCount !== count) {
    return `count: ${count} of ${totalCount} total`;
  }

  if (limit !== undefined && count === limit && count > 0) {
    return `count: ${count} (showing first ${count})`;
  }

  return `count: ${count}`;
}
