"use client";

import { useEffect, useState } from "react";
import { Eye, EyeClosed } from "iconoir-react";
import { Pulse } from "./Pulse";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.host), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    if (res?.ok) {
      window.location.href = "/";
      return;
    }
    const data = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    setError(data?.error ?? "Couldn't reach the server.");
    setBusy(false);
  };

  return (
    <form onSubmit={submit} noValidate className="flex w-full max-w-[320px] flex-col gap-6" style={{ animation: "fade-in 160ms ease-out both" }}>
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex size-9 items-center justify-center rounded-[9px] bg-ink">
          <Pulse busy={busy} size={4} cellClass="bg-surface" />
        </span>
        <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.015em] text-ink">Sign in to agent-u</h1>
          <p className="mt-0.5 min-h-[18px] text-[12.5px] text-ink-3" translate="no">
            {host}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="password" className="text-[12.5px] font-medium text-ink-2">
          Password
        </label>
        <div
          className={`flex h-10 items-center rounded-[8px] border bg-surface pr-1 transition-[border-color,box-shadow] duration-150 ${
            error ? "border-red shadow-[0_0_0_3px_color-mix(in_oklch,var(--red)_18%,transparent)]" : "field-ring border-line-strong"
          }`}
        >
          <input
            id="password"
            name="password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "login-error" : undefined}
            className="h-full min-w-0 flex-1 bg-transparent px-3 text-[16px] text-ink outline-none sm:text-[14px] sm:pointer-coarse:text-[16px]"
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "Hide password" : "Show password"}
            aria-pressed={show}
            className="tap relative flex size-8 shrink-0 items-center justify-center rounded-[6px] text-ink-3 hover:bg-hover hover:text-ink"
          >
            {show ? <EyeClosed width={16} height={16} strokeWidth={1.8} /> : <Eye width={16} height={16} strokeWidth={1.8} />}
          </button>
        </div>
        {error && (
          <p id="login-error" role="alert" className="text-[12.5px] text-red-ink">
            {error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={busy || !password}
        className="tap relative flex h-10 w-full items-center justify-center rounded-[8px] bg-ink text-[13.5px] font-medium text-page transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>

      <p className="text-center text-[12px] leading-relaxed text-ink-3">This password opens a shell on the server. Treat it like an SSH key.</p>
    </form>
  );
}
