import crypto from "node:crypto";

/** `data` as JSON with a content hash ETag; a request whose If-None-Match already names it gets an empty 304. */
export function jsonWithEtag(req: Request, data: unknown): Response {
  const body = JSON.stringify(data);
  const etag = `"${crypto.createHash("sha1").update(body).digest("base64url")}"`;
  /* revalidated on every use; never kept by a shared cache (the list is behind the login) */
  const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (matches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
}

/* weak validators compare equal to strong ones here (a proxy may weaken them when it compresses) */
function matches(header: string | null, etag: string) {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === etag);
}
