"use client";

import { useCallback, useEffect, useState } from "react";
import { Refresh } from "iconoir-react";
import { api, shortPath } from "@/lib/client/api";
import { useSetting } from "@/lib/client/settings";
import { toast } from "@/lib/client/toast";
import type { CleanupResult, Plan, StorageReport } from "@/lib/server/storage";
import { SettingField } from "./SettingField";
import { Card, Row, SmallButton } from "./controls";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")} ${units[i]}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ago(at: number, now = Date.now()): string {
  const min = Math.round((now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${plural(min, "minute")} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${plural(h, "hour")} ago`;
  return `${plural(Math.round(h / 24), "day")} ago`;
}

function Value({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-ink-2 tabular-nums">{children}</span>;
}

function Usage({ data, loading, onRefresh }: { data: StorageReport | null; loading: boolean; onRefresh: () => void }) {
  const wt = data?.worktrees;
  const measuring = <Value>Measuring…</Value>;
  return (
    <Card
      title="Disk usage"
      footer={
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1">{wt ? `Worktrees live in ${shortPath(wt.root)}.` : "Sizes are read from the server's disk."}</span>
          <button type="button" onClick={onRefresh} disabled={loading} aria-label="Measure again" title="Measure again" className="tap relative grid size-6 place-items-center rounded-[6px] text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-50">
            <Refresh width={13} height={13} strokeWidth={2} aria-hidden />
          </button>
        </span>
      }
    >
      <Row label="Worktrees" note={wt ? (wt.items.length ? plural(wt.items.length, "worktree") : "None yet.") : "Folders for sessions started in their own worktree."}>
        {wt ? <Value>{formatBytes(wt.bytes)}</Value> : measuring}
      </Row>
      <Row label="Attachments" note={data ? (data.attachments.count ? plural(data.attachments.count, "message", "messages") + " with files" : "None.") : "Files uploaded with messages."}>
        {data ? <Value>{formatBytes(data.attachments.bytes)}</Value> : measuring}
      </Row>
      <Row label="Checkpoints" note="Saved before each message sent here, inside each repository. Older ones are pruned on their own.">
        {data ? <Value>{data.checkpoints.refs ? `${plural(data.checkpoints.refs, "ref")} in ${plural(data.checkpoints.repos, "repository", "repositories")}` : "None"}</Value> : measuring}
      </Row>
    </Card>
  );
}

function Worktrees({ data }: { data: StorageReport }) {
  const items = [...data.worktrees.items].sort((a, b) => b.bytes - a.bytes);
  if (!items.length) return null;
  return (
    <Card title="Worktrees">
      {items.map((w) => {
        const flags = [w.running && "Running", w.dirty && "Uncommitted changes", w.merged && "Merged", w.unreadable && "Can't read"].filter(Boolean).join(" · ");
        return (
          <Row
            key={w.path}
            label={
              <span className="block truncate font-mono text-[12.5px]" title={w.path} translate="no">
                {w.branch ?? shortPath(w.path)}
              </span>
            }
            note={`Last active ${ago(w.lastActive)}${flags ? ` · ${flags}` : ""}`}
          >
            <Value>{formatBytes(w.bytes)}</Value>
          </Row>
        );
      })}
    </Card>
  );
}

function CleanNow({ data, onDone }: { data: StorageReport | null; onDone: () => void }) {
  const [wtDays] = useSetting("worktreeCleanupDays");
  const [attDays] = useSetting("attachmentCleanupDays");
  const off = wtDays === "off" && attDays === "off";
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<"plan" | "clean" | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setPlan(null), [wtDays, attDays]);

  const review = async () => {
    setBusy("plan");
    setError(null);
    try {
      setPlan(await api<Plan>("/api/storage", { action: "plan" }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const clean = async () => {
    if (!plan) return;
    setBusy("clean");
    setError(null);
    try {
      const r = await api<CleanupResult>("/api/storage", { action: "clean", paths: plan.items.map((i) => i.path) });
      setPlan(null);
      toast({
        key: "storage-clean",
        tone: r.failed.length ? "error" : "success",
        title: r.removed.length ? `Removed ${plural(r.removed.length, "item")}, freed ${formatBytes(r.bytes)}` : "Nothing was removed",
        body: r.failed.length ? `${plural(r.failed.length, "item")} couldn't be removed: ${r.failed[0].error}` : undefined,
      });
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const last = data?.lastCleanup;
  const note = off
    ? "Pick when to remove worktrees or attachments above first."
    : last
      ? `Last cleanup ${ago(last.at)}: removed ${plural(last.removed, "item")}, ${formatBytes(last.bytes)}. Runs on its own once a day.`
      : "Runs on its own once a day. Shows what would go before deleting anything.";
  return (
    <Card>
      <Row label="Clean up now" note={note}>
        {plan ? (
          <SmallButton onClick={() => setPlan(null)} disabled={busy === "clean"}>
            Cancel
          </SmallButton>
        ) : (
          <SmallButton onClick={() => void review()} disabled={off || busy !== null}>
            {busy === "plan" ? "Checking…" : "Review"}
          </SmallButton>
        )}
      </Row>
      {error && (
        <p role="alert" className="px-3.5 py-2.5 text-sm text-red-ink">
          {error}
        </p>
      )}
      {plan && (
        <div className="flex flex-col gap-2.5 px-3.5 py-3" role="region" aria-label="Cleanup preview">
          {plan.items.length ? (
            <>
              <p className="text-sm text-ink">
                {plural(plan.items.length, "item")} would go, freeing {formatBytes(plan.bytes)}:
              </p>
              <ul className="max-h-64 divide-y divide-line overflow-y-auto rounded-control bg-inset text-xs shadow-hairline">
                {plan.items.map((i) => (
                  <li key={i.path} className="flex min-w-0 items-center gap-3 px-2.5 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-ink-2" title={i.path} translate="no">
                        {i.kind === "worktree" ? (i.branch ?? shortPath(i.path)) : shortPath(i.path)}
                      </span>
                      <span className="block text-ink-3">
                        {i.kind === "worktree" ? "Worktree" : "Attachments"} · {i.reason}
                        {i.kind === "worktree" && !i.merged && i.branch ? " · branch kept" : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-ink-3 tabular-nums">{formatBytes(i.bytes)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-ink-3">Nothing to clean up.</p>
          )}
          {plan.kept.length > 0 && (
            <p className="text-xs leading-relaxed text-ink-3">
              Kept: {plan.kept.map((k) => `${shortPath(k.path).split("/").pop()} (${k.reason.toLowerCase()})`).join(", ")}.
            </p>
          )}
          {plan.items.length > 0 && (
            <div className="flex justify-end">
              <SmallButton tone="danger" onClick={() => void clean()} disabled={busy !== null}>
                {busy === "clean" ? "Deleting…" : `Delete ${plural(plan.items.length, "item")}`}
              </SmallButton>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** Settings > Storage: disk usage, the cleanup policies, and a cleanup that shows its list before it deletes. */
export function StorageSection() {
  const [data, setData] = useState<StorageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      setData(await api<StorageReport>(`/api/storage${fresh ? "?fresh=1" : ""}`));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void load(), [load]);
  return (
    <>
      <Usage data={data} loading={loading} onRefresh={() => void load(true)} />
      {error && (
        <p role="alert" className="px-1 text-sm text-red-ink">
          Couldn&apos;t measure storage: {error}
        </p>
      )}
      <Card title="Cleanup">
        <SettingField k="worktreeCleanupDays" />
        <SettingField k="attachmentCleanupDays" />
      </Card>
      <CleanNow data={data} onDone={() => void load(true)} />
      {data && <Worktrees data={data} />}
    </>
  );
}
