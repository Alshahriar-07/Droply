/**
 * Shared progress snapshot shape for the sender and receiver engines so the
 * transfer UI has one contract to render.
 */

/**
 * @param {{
 *   entries: Array<{ id: string, name: string, size: number, type?: string, transferred: number }>,
 *   transferredBytes: number,
 *   totalBytes: number,
 *   activeIndex: number,
 *   speedMeter: { rate: () => number, eta: (remaining: number) => number|null },
 *   complete?: boolean
 * }} input
 */
export function buildProgressDetail({
  entries,
  transferredBytes,
  totalBytes,
  activeIndex,
  speedMeter,
  complete = false,
}) {
  const remaining = Math.max(0, totalBytes - transferredBytes);
  const speed = speedMeter.rate();
  const ratio = totalBytes > 0 ? Math.min(1, transferredBytes / totalBytes) : complete ? 1 : 0;

  return {
    transferredBytes,
    totalBytes,
    ratio,
    speed,
    eta: complete ? 0 : speedMeter.eta(remaining),
    activeIndex,
    complete,
    files: entries.map((entry, index) => {
      const done = entry.transferred >= entry.size && (entry.size > 0 || complete);
      return {
        id: entry.id,
        name: entry.name,
        size: entry.size,
        type: entry.type ?? "",
        transferred: Math.min(entry.transferred, entry.size),
        ratio: entry.size > 0 ? Math.min(1, entry.transferred / entry.size) : done ? 1 : 0,
        state: done ? "done" : index === activeIndex ? "active" : "pending",
      };
    }),
  };
}
