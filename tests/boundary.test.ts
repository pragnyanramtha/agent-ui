import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Boundary, EntryFallback, RAW_MAX, rawJson } from "@/components/claude/Boundary";

afterEach(() => vi.restoreAllMocks());

describe("rawJson", () => {
  it("indents the entry and leaves short ones whole", () => {
    const r = rawJson({ kind: "tool", input: { edits: "nope" } });
    expect(r.full).toBe(JSON.stringify({ kind: "tool", input: { edits: "nope" } }, null, 2));
    expect(r.shown).toBe(r.full);
    expect(r.truncated).toBe(false);
  });

  it("caps what is shown but keeps the full text for copying", () => {
    const r = rawJson({ text: "x".repeat(RAW_MAX * 2) });
    expect(r.truncated).toBe(true);
    expect(r.shown).toHaveLength(RAW_MAX);
    expect(r.full.length).toBeGreaterThan(RAW_MAX * 2);
  });

  it("survives cycles, BigInt and undefined", () => {
    const a: Record<string, unknown> = { n: BigInt(7) };
    a.self = a;
    const r = rawJson(a);
    expect(r.full).toContain('"[Circular]"');
    expect(r.full).toContain('"7n"');
    expect(rawJson(undefined).full).toBe("undefined");
  });
});

describe("Boundary", () => {
  const props = (over: Record<string, unknown> = {}) => ({ children: createElement("p", null, "fine"), resetKey: 1, entry: { id: "e1" }, ...over });

  it("renders its children while nothing has failed", () => {
    const b = new Boundary(props());
    expect(renderToStaticMarkup(b.render() as never)).toBe("<p>fine</p>");
  });

  it("swaps in the fallback card after a render error and logs it", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = new Boundary(props({ label: "run" }));
    b.state = Boundary.getDerivedStateFromError();
    b.componentDidCatch(new TypeError("x.map is not a function"), { componentStack: "\n    at ToolRun" });
    expect(log).toHaveBeenCalledWith("[agent-u] run failed to render", expect.any(TypeError), "\n    at ToolRun");
    const html = renderToStaticMarkup(b.render() as never);
    expect(html).toContain("Couldn&#x27;t show this message.");
    expect(html).toContain("Show raw");
    expect(html).toContain("Copy");
    expect(html).not.toContain("fine");
  });

  it("uses a custom fallback and hands it a retry", () => {
    const b = new Boundary(props({ fallback: (retry: () => void) => createElement("button", { onClick: retry }, "Retry") }));
    b.state = { failed: true };
    const set = vi.spyOn(b, "setState").mockImplementation(() => {});
    expect(renderToStaticMarkup(b.render() as never)).toBe("<button>Retry</button>");
    b.retry();
    expect(set).toHaveBeenCalledWith({ failed: false });
  });

  it("clears the error when resetKey changes, not on other updates", () => {
    const b = new Boundary(props({ resetKey: 2 }));
    b.state = { failed: true };
    const set = vi.spyOn(b, "setState").mockImplementation(() => {});
    b.componentDidUpdate(props({ resetKey: 2 }), { failed: true });
    expect(set).not.toHaveBeenCalled();
    /* the error that just happened in this same update must not be wiped right away */
    b.componentDidUpdate(props({ resetKey: 1 }), { failed: false });
    expect(set).not.toHaveBeenCalled();
    b.componentDidUpdate(props({ resetKey: 1 }), { failed: true });
    expect(set).toHaveBeenCalledWith({ failed: false });
  });
});

describe("EntryFallback", () => {
  it("offers raw and copy only when there is an entry, plus extra actions", () => {
    const bare = renderToStaticMarkup(createElement(EntryFallback, { message: "This panel failed to load." }));
    expect(bare).toContain("This panel failed to load.");
    expect(bare).not.toContain("Show raw");
    const withActions = renderToStaticMarkup(createElement(EntryFallback, { entry: { a: 1 }, actions: createElement("button", null, "Deny") }));
    expect(withActions).toContain("Show raw");
    expect(withActions).toContain("Deny");
    expect(withActions).toContain('role="alert"');
  });
});
