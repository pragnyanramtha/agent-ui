import type { NextRequest } from "next/server";
import { COOKIE, verifySession } from "@/lib/auth";
import { allowedHosts, hostAllowed } from "@/lib/hosts";

/** "null" (sandboxed/opaque origins) and garbage don't parse; treat them as no origin. */
function originHost(origin: string | null) {
  try {
    return origin ? new URL(origin).host : null;
  } catch {
    return null;
  }
}

let warned = false;
/** Host is one of ours (lib/hosts.ts); servers set up before ALLOWED_HOSTS existed accept any Host, with one warning */
export function hostOk(req: NextRequest) {
  const allow = allowedHosts();
  if (!allow && !warned) {
    warned = true;
    console.warn("agent-u: neither ALLOWED_HOSTS nor PUBLIC_HOSTNAME is set, so any Host header is accepted (DNS rebinding). Set one in .env.local.");
  }
  return hostAllowed(req.headers.get("host"), allow);
}

/* Defence in depth on top of SameSite=strict: state-changing API calls must come from this origin.
 * Behind a tunnel Host is the public name and x-forwarded-host may be missing or point elsewhere, so either may match. */
export function sameOrigin(req: NextRequest) {
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")?.split(",")[0].trim()].filter(Boolean);
  return hosts.includes(originHost(req.headers.get("origin")));
}

export const signedIn = (req: NextRequest) => verifySession(req.cookies.get(COOKIE)?.value);

/** routes the middleware skips (it buffers bodies, which breaks large uploads) check here instead */
export async function guard(req: NextRequest): Promise<Response | null> {
  if (!hostOk(req)) return Response.json({ error: "Unknown host" }, { status: 421 });
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return Response.json({ error: "Bad origin" }, { status: 403 });
  if (!(await signedIn(req))) return Response.json({ error: "Sign in first" }, { status: 401 });
  return null;
}
