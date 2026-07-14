export const IMGN_WORKER_MIN_DELAY_MS = 1_000;
export const IMGN_WORKER_IDLE_DELAY_MS = 5 * 60_000;
export const IMGN_WORKER_ERROR_DELAY_MS = 60_000;
export const IMGN_PROMPT_CLEANUP_INTERVAL_MS = 60 * 60_000;

export type ScheduledGenerationJob = {
  next_retry_at: string | null;
};

export function nextGenerationWorkerDelay(
  jobs: ScheduledGenerationJob[],
  nowMs = Date.now(),
): number {
  if (jobs.length === 0) return IMGN_WORKER_IDLE_DELAY_MS;

  const earliestRetry = jobs.reduce((earliest, job) => {
    if (!job.next_retry_at) return nowMs;
    const parsed = new Date(job.next_retry_at).getTime();
    return Math.min(earliest, Number.isFinite(parsed) ? parsed : nowMs);
  }, Number.POSITIVE_INFINITY);

  return Math.min(
    IMGN_WORKER_IDLE_DELAY_MS,
    Math.max(IMGN_WORKER_MIN_DELAY_MS, earliestRetry - nowMs),
  );
}
