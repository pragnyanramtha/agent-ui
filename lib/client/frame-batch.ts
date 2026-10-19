/**
 * Collects items and hands them over together once per animation frame, so a burst of stream
 * events costs one render. Hidden tabs get no frames, so a timer flushes after `maxWaitMs` too.
 */
export function frameBatch<T>(flush: (items: T[]) => void, maxWaitMs = 100) {
  let items: T[] = [];
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(timer);
    timer = undefined;
  };
  const run = () => {
    clear();
    if (!items.length) return;
    const batch = items;
    items = [];
    flush(batch);
  };
  return {
    push(item: T) {
      items.push(item);
      if (timer !== undefined) return;
      timer = setTimeout(run, maxWaitMs);
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(run);
    },
    /** hands over what is waiting now (before anything that must come after it) */
    flush: run,
    /** drops what is waiting */
    cancel() {
      clear();
      items = [];
    },
  };
}
