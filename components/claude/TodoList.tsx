type Todo = { content?: string; status?: string; activeForm?: string };

function Ring({ active, spin, children }: { active?: boolean; spin?: boolean; children: React.ReactNode }) {
  const size = 22;
  const r = (size - 2) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        className={`absolute inset-0 ${active && spin ? "animate-[spin_1.1s_linear_infinite] motion-reduce:animate-none [animation-play-state:var(--run-play,running)]" : ""}`}
        aria-hidden
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-strong)" strokeWidth={2} />
        {active && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ink-2)" strokeWidth={2} strokeLinecap="round" strokeDasharray={`${c * 0.28} ${c * 0.72}`} />}
      </svg>
      <span className="relative text-[10px] font-semibold text-ink tabular-nums">{children}</span>
    </span>
  );
}

/**
 * TodoWrite as Beautiful UI's TaskRows (list variant): one row per task, live status on the left.
 * The in-progress ring only turns while the run is `live`; an old snapshot in history sits still.
 */
export function TodoList({ todos, live = false }: { todos: Todo[]; live?: boolean }) {
  return (
    <div className="w-full overflow-hidden rounded-card bg-surface shadow-card">
      {todos.map((t, i) => {
        const status = t.status ?? "pending";
        return (
          <div key={i} className="flex min-h-10 items-center gap-2.5 border-b border-line px-2.5 py-1.5 last:border-0">
            {status === "completed" ? (
              <span className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-green text-white">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6L9 17l-5-5" /></svg>
              </span>
            ) : (
              <Ring active={status === "in_progress"} spin={live}>
                {i + 1}
              </Ring>
            )}
            <span className={`min-w-0 flex-1 text-sm [overflow-wrap:anywhere] ${status === "completed" ? "text-ink-3 line-through decoration-line-strong" : "font-medium text-ink"}`}>
              {status === "in_progress" ? t.activeForm || t.content : t.content}
            </span>
            {status === "in_progress" && (
              <span className="inline-flex h-5.5 shrink-0 items-center rounded-full bg-accent-tint px-2 text-xs font-medium text-accent-ink">Now</span>
            )}
          </div>
        );
      })}
      <span className="sr-only">
        {todos.filter((t) => t.status === "completed").length} of {todos.length} tasks complete
      </span>
    </div>
  );
}
