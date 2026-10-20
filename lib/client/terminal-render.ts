/* The GPU renderer sizes its canvas from ResizeObserver's device-pixel-content-box. Chrome's device
 * emulation (DevTools device mode, headless phone runs) reports that box in CSS pixels while
 * devicePixelRatio says 2 or 3, so the canvas gets a third of the pixels it draws and the screen
 * stays blank. Where the two disagree, the terminal uses the DOM renderer instead. */

/** Whether a device-pixel box of `device` px for `css` CSS px matches `dpr` */
export function devicePixelsMatch(css: number, device: number, dpr: number): boolean {
  return Math.abs(device - css * dpr) <= Math.max(2, dpr);
}

let verdict: Promise<boolean> | null = null;

/** True unless the browser reports device-pixel boxes that don't match devicePixelRatio */
export function deviceBoxTrusted(): Promise<boolean> {
  return (verdict ??= new Promise<boolean>((resolve) => {
    const dpr = window.devicePixelRatio || 1;
    if (dpr === 1 || typeof ResizeObserver === "undefined") return resolve(true);
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-200px;top:0;width:100px;height:10px;visibility:hidden;pointer-events:none";
    document.body.append(probe);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      ro.disconnect();
      probe.remove();
      resolve(ok);
    };
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.devicePixelContentBoxSize?.[0];
      /* no device-pixel boxes: the renderer stops observing and keeps its own sizes */
      finish(!box || devicePixelsMatch(100, box.inlineSize, dpr));
    });
    try {
      ro.observe(probe, { box: "device-pixel-content-box" });
    } catch {
      finish(true);
    }
    setTimeout(() => finish(true), 500);
  }));
}
