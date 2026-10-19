/** Settings > Reduce motion: "On" and "Off" win over the device, "System" asks it. */
export function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  const pref = document.documentElement.getAttribute("data-motion");
  if (pref === "on") return true;
  if (pref === "off") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** For scrollTo/scrollIntoView, which CSS `scroll-behavior` can't override once "smooth" is asked for. */
export const scrollBehavior = (): ScrollBehavior => (reducedMotion() ? "auto" : "smooth");
