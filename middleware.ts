import { NextResponse, type NextRequest } from "next/server";
import { hostOk, sameOrigin, signedIn } from "@/lib/guard";

const PUBLIC = ["/login", "/api/auth/login", "/manifest.webmanifest", "/icon.svg", "/apple-touch-icon.png", "/sw.js"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const api = pathname.startsWith("/api/");

  if (!hostOk(req)) return new NextResponse("Unknown host.", { status: 421, headers: { "Content-Type": "text/plain" } });

  /* state-changing API calls must come from this origin (see lib/guard.ts) */
  if (api && req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  if (PUBLIC.includes(pathname)) return NextResponse.next();
  if (await signedIn(req)) return NextResponse.next();

  if (api) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  return NextResponse.redirect(loginUrl(req));
}

/* Next can't send a relative Location from middleware (it parses it as a URL, and turns 127.0.0.1 into localhost),
 * so the redirect is built from the Host the browser used, which hostOk vetted; never from x-forwarded-host, which any
 * client can send. Behind the tunnel Host is the public name and x-forwarded-proto says https. */
function loginUrl(req: NextRequest) {
  const proto = req.headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  try {
    return new URL("/login", `${proto}://${req.headers.get("host") ?? req.nextUrl.host}`);
  } catch {
    return new URL("/login", req.url);
  }
}

export const config = {
  runtime: "nodejs",
  /* /api/files/upload runs the same checks itself (lib/guard.ts): middleware would buffer its body */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/files/upload).*)"],
};
