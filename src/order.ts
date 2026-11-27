import type { DriverElement } from "./model.ts";

/** Top-to-bottom rows, left-to-right within a row; elements whose vertical centres are within half a line height share a row. */
export function readingOrder<T extends Pick<DriverElement, "frame">>(items: T[]): T[] {
  const cy = (e: T) => e.frame.y + e.frame.h / 2;
  const sorted = [...items].sort((a, b) => cy(a) - cy(b));
  const rows: T[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    const head = row?.[0];
    if (row && head && Math.abs(cy(item) - cy(head)) <= Math.min(item.frame.h, head.frame.h) / 2) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.frame.x - b.frame.x));
}
