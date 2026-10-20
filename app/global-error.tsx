"use client";

/* Replaces the root layout when it fails, so it brings its own <html> and plain styles. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "#17181a", color: "#e6e8ec", font: "14px system-ui, sans-serif" }}>
        <div style={{ maxWidth: 360, padding: 24, textAlign: "center" }}>
          <p style={{ fontWeight: 600, margin: 0 }}>agent-u failed to load</p>
          <p style={{ color: "#9a9fa8", fontSize: 13 }}>Sessions keep running.</p>
          {error.message && <p style={{ color: "#6b7079", fontFamily: "monospace", fontSize: 11.5, wordBreak: "break-word" }}>{error.message}</p>}
          <button type="button" onClick={() => (reset ? reset() : location.reload())} style={{ marginTop: 8, height: 36, padding: "0 16px", borderRadius: 999, border: 0, background: "#e6e8ec", color: "#17181a", fontWeight: 500 }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
