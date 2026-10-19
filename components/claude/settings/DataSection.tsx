"use client";

import { useRef, useState } from "react";
import { Download, Upload } from "iconoir-react";
import { exportSettings, importSettings, resetAllSettings, setSettings, type ImportResult } from "@/lib/client/settings";
import { Card, Row, SmallButton } from "./controls";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const MAX_BYTES = 256 * 1024;

export function DataSection() {
  const file = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [undone, setUndone] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setUndone(false);
    if (f.size > MAX_BYTES) return setResult({ ok: false, error: "That file is too big to be a settings file." });
    setResult(importSettings(await f.text()));
  };

  return (
    <>
      <Card title="Back up and move">
        <Row label="Export settings" note="Every setting, from this device and the server, as a JSON file.">
          <SmallButton onClick={() => download(`agent-u-settings-${new Date().toISOString().slice(0, 10)}.json`, exportSettings())}>
            <Download width={14} height={14} strokeWidth={1.9} aria-hidden />
            Export
          </SmallButton>
        </Row>
        <Row label="Import settings" note="Apply a file exported here or on another device.">
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <SmallButton onClick={() => file.current?.click()}>
            <Upload width={14} height={14} strokeWidth={1.9} aria-hidden />
            Import
          </SmallButton>
        </Row>
        {result && (
          <div role="status" className="px-3.5 py-3 text-sm">
            {!result.ok ? (
              <p className="text-red-ink">{result.error}</p>
            ) : undone ? (
              <p className="text-ink-2">Import undone.</p>
            ) : result.changes.length === 0 ? (
              <p className="text-ink-2">Nothing changed. These settings were already in use.</p>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <p className="flex-1 font-medium text-ink">
                    {result.changes.length === 1 ? "1 setting changed" : `${result.changes.length} settings changed`}
                  </p>
                  <SmallButton
                    onClick={() => {
                      setSettings(result.previous);
                      setUndone(true);
                    }}
                  >
                    Undo
                  </SmallButton>
                </div>
                <ul className="flex flex-col divide-y divide-line rounded-control bg-inset px-2.5 shadow-hairline">
                  {result.changes.map((c) => (
                    <li key={c.key} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                      <span className="min-w-0 flex-1 text-ink">{c.label}</span>
                      <span className="text-ink-3 line-through decoration-ink-3/50">{c.from}</span>
                      <span className="text-ink-3" aria-hidden>
                        to
                      </span>
                      <span className="sr-only">changed to</span>
                      <span className="font-medium text-ink">{c.to}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.ok && result.skipped.length > 0 && !undone && (
              <p className="mt-2 text-ink-3">
                Skipped {result.skipped.length === 1 ? "1 entry" : `${result.skipped.length} entries`} this version doesn&apos;t know: {result.skipped.slice(0, 6).join(", ")}
                {result.skipped.length > 6 ? ", …" : ""}
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="Reset">
        <Row label="Reset all settings" note={resetDone ? "Everything is back to its default." : "Every section, on this device and on the server."}>
          {confirm ? (
            <span className="flex gap-1.5">
              <SmallButton onClick={() => setConfirm(false)}>Cancel</SmallButton>
              <SmallButton
                tone="danger"
                onClick={() => {
                  resetAllSettings();
                  setConfirm(false);
                  setResetDone(true);
                }}
              >
                Reset all
              </SmallButton>
            </span>
          ) : (
            <SmallButton
              tone="danger"
              onClick={() => {
                setConfirm(true);
                setResetDone(false);
              }}
            >
              Reset all…
            </SmallButton>
          )}
        </Row>
      </Card>
    </>
  );
}
