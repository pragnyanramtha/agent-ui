import { NextResponse, type NextRequest } from "next/server";
import { hostOk, sameOrigin, signedIn } from "@/lib/guard";
import { SHARE_PARAM, SHARE_TOO_BIG, sharedText } from "@/lib/share";
import { keepShared, SHARE_MAX_BYTES } from "@/lib/server/share";

export const dynamic = "force-dynamic";

/* Built from the Host the browser used (vetted by hostOk), like the middleware's login redirect. */
function here(req: NextRequest, to: string) {
  const proto = req.headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  try {
    return new URL(to, `${proto}://${req.headers.get("host") ?? req.nextUrl.host}`);
  } catch {
    return new URL(to, req.url);
  }
}

const text = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : null);

/**
 * The manifest's share_target: another app's text, link and files, posted as multipart by the browser itself.
 * The middleware skips this path (it buffers bodies, and shared videos are large), so the same checks run here.
 */
export async function POST(req: NextRequest) {
  if (!hostOk(req)) return new NextResponse("Unknown host.", { status: 421, headers: { "Content-Type": "text/plain" } });
  /* the share sheet's post can carry an opaque origin ("null"); a named one must be ours */
  const origin = req.headers.get("origin");
  if (origin && origin !== "null" && !sameOrigin(req)) return new NextResponse("Bad origin.", { status: 403, headers: { "Content-Type": "text/plain" } });
  if (!(await signedIn(req))) return NextResponse.redirect(here(req, "/login"), 303);
  const declared = req.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) return new NextResponse("Length required.", { status: 411, headers: { "Content-Type": "text/plain" } });
  if (Number(declared) > SHARE_MAX_BYTES) return NextResponse.redirect(here(req, `/?s=new&${SHARE_PARAM}=${SHARE_TOO_BIG}`), 303);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.redirect(here(req, "/?s=new"), 303);
  }
  const message = sharedText({ title: text(form.get("title")), text: text(form.get("text")), url: text(form.get("url")) });
  const files = form.getAll("files").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (!message && !files.length) return NextResponse.redirect(here(req, "/?s=new"), 303);
  const id = await keepShared(message, files);
  return NextResponse.redirect(here(req, `/?s=new&${SHARE_PARAM}=${id}`), 303);
}
