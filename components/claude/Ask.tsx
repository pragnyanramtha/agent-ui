"use client";

import { useCallback, useEffect, useState } from "react";
import { field, primaryBtn, secondaryBtn, Sheet } from "./Sheet";

type Options = { title: string; body?: string; confirm: string; danger?: boolean };
type Request = Options & { input?: string; resolve: (v: string | boolean | null) => void };

let show: ((r: Request) => void) | null = null;

/** An in-app confirm(); resolves false when dismissed. */
export function confirmAsk(o: Options): Promise<boolean> {
  if (!show) return Promise.resolve(window.confirm(o.body ? `${o.title}\n\n${o.body}` : o.title));
  return new Promise((resolve) => show?.({ ...o, resolve: (v) => resolve(v === true) }));
}

/** An in-app prompt(); resolves the trimmed text, or null when dismissed or left empty. */
export function promptAsk(o: Options & { value?: string }): Promise<string | null> {
  if (!show) return Promise.resolve(window.prompt(o.title, o.value ?? "")?.trim() || null);
  return new Promise((resolve) => show?.({ ...o, input: o.value ?? "", resolve: (v) => resolve(typeof v === "string" && v.trim() ? v.trim() : null) }));
}

/** Mounted once; renders whatever confirmAsk / promptAsk asked for. */
export function AskHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    show = (r) => {
      setValue(r.input ?? "");
      setReq((old) => {
        old?.resolve(null);
        return r;
      });
    };
    return () => {
      show = null;
    };
  }, []);
  const done = useCallback(
    (v: string | boolean | null) => {
      req?.resolve(v);
      setReq(null);
    },
    [req],
  );
  const cancel = useCallback(() => done(null), [done]);
  if (!req) return null;
  const prompt = req.input !== undefined;
  const ok = () => done(prompt ? value : true);
  return (
    <Sheet
      title={req.title}
      onClose={cancel}
      footer={
        <>
          <button type="button" onClick={cancel} className={secondaryBtn}>
            Cancel
          </button>
          <button
            type="button"
            data-autofocus
            onClick={ok}
            disabled={prompt && !value.trim()}
            className={req.danger ? `${primaryBtn} bg-red text-white` : primaryBtn}
          >
            {req.confirm}
          </button>
        </>
      }
    >
      {req.body && <p className="text-sm leading-relaxed text-ink-2">{req.body}</p>}
      {prompt && (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => !e.nativeEvent.isComposing && e.keyCode !== 229 && e.key === "Enter" && value.trim() && ok()}
          onFocus={(e) => {
            const dot = e.target.value.lastIndexOf(".");
            e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
          }}
          aria-label={req.title}
          className={`${field} ${req.body ? "mt-3" : ""}`}
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </Sheet>
  );
}
