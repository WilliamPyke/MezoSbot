const loopLagSamples: number[] = [];
let previous = performance.now();
const intervalMs = 1_000;

setInterval(() => {
  const now = performance.now();
  loopLagSamples.push(Math.max(0, now - previous - intervalMs));
  if (loopLagSamples.length > 300) loopLagSamples.shift();
  previous = now;
}, intervalMs).unref();

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentileValue))];
}

export function telemetrySnapshot(): Record<string, number> {
  const memory = process.memoryUsage();
  return {
    eventLoopLagP99Ms: Math.round(percentile(loopLagSamples, 0.99) * 100) / 100,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}

export function metric(name: string, value: number, attributes: Record<string, string | number | boolean> = {}): void {
  console.log(JSON.stringify({ level: "info", service: "bot", metric: name, value, ...attributes }));
}
