import { api, ApiError } from "./api";

/* Posting over a bad connection. Each send carries a client id; the server answers a repeat of
 * the same id with the first answer, so retrying after a lost response never sends twice. */

export const newClientId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** the tunnel or app is restarting, or the request never got an answer. A JSON `error` came from the app itself
 * (api() only falls back to "Request failed (status)" without one), so it is final whatever the status. */
export const transient = (err: unknown) =>
  !(err instanceof ApiError) || (err.message === `Request failed (${err.status})` && [502, 503, 504, 520, 521, 522, 523, 524, 530].includes(err.status));

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => (clearTimeout(t), signal?.removeEventListener("abort", done), resolve());
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/* navigator.onLine can be wrong (some VPNs), so waiting for "online" is capped and the request is tried anyway */
const backOnline = (signal?: AbortSignal, maxMs = 15_000) =>
  navigator.onLine
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const t = setTimeout(() => done(), maxMs);
        const done = () => (clearTimeout(t), window.removeEventListener("online", done), signal?.removeEventListener("abort", done), resolve());
        window.addEventListener("online", done);
        signal?.addEventListener("abort", done, { once: true });
      });

/** POST `body` with `clientId`, retrying network failures for up to `forMs`. Other errors throw at once. */
export async function postReliably<T>(url: string, body: Record<string, unknown>, clientId: string, opts: { forMs?: number; signal?: AbortSignal; onRetry?: (n: number) => void } = {}): Promise<T> {
  const until = Date.now() + (opts.forMs ?? 90_000);
  for (let n = 0; ; n++) {
    await backOnline(opts.signal);
    try {
      return await api<T>(url, { ...body, clientId });
    } catch (err) {
      if (!transient(err) || Date.now() > until || opts.signal?.aborted) throw err;
      opts.onRetry?.(n + 1);
      await sleep(Math.min(8000, 700 * 2 ** n), opts.signal);
    }
  }
}

export type Answer = { requestId: string; allow: boolean; always?: boolean; answers?: Record<string, string> };

/** Answers an approval or question. One client id for all its retries, so an answer whose reply was lost can't land twice. */
export const answerAsk = (session: string, body: Answer) => postReliably<{ ok: true }>(`/api/sessions/${encodeURIComponent(session)}/respond`, body, newClientId(), { forMs: 30_000 });

/** what to tell the user when a post failed */
export const failureText = (err: unknown) => (err instanceof ApiError && !transient(err) ? err.message : "Couldn't reach the server.");
