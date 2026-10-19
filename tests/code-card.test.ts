import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeCard } from "@/components/claude/CodeCard";
import { highlight } from "@/lib/client/highlight";

const code = (n: number) => Array.from({ length: n }, (_, i) => `const v${i + 1} = "x";`).join("\n") + "\n";
const render = (props: { code: string; label?: string; collapsible?: boolean }) => renderToStaticMarkup(createElement(CodeCard, props));

describe("CodeCard", () => {
  it("renders one pre and one gutter element, not an element per line", () => {
    const html = render({ code: code(12), label: "ts" });
    expect(html.match(/<pre/g)).toHaveLength(1);
    expect(html.match(/<code/g)).toHaveLength(1);
    expect(html).toContain(`>${Array.from({ length: 12 }, (_, i) => i + 1).join("\n")}</span>`);
    expect(html).not.toContain("grid");
  });

  it("collapses long blocks behind Show all and keeps the gutter in step", () => {
    const html = render({ code: code(100), label: "ts", collapsible: true });
    expect(html).toContain("Show all 100 lines");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("v30");
    expect(html).not.toContain("v31");
    expect(html).toContain(`>${Array.from({ length: 30 }, (_, i) => i + 1).join("\n")}</span>`);
  });

  it("leaves short blocks and blocks without a limit whole", () => {
    expect(render({ code: code(40), label: "ts", collapsible: true })).not.toContain("Show all");
    const html = render({ code: code(100), label: "ts" });
    expect(html).not.toContain("Show all");
    expect(html).toContain("v100");
  });

  it("plain text is a single text run", () => {
    const html = render({ code: "for and from\nsecond line\n", label: "txt" });
    expect(html).toContain("<code>for and from\nsecond line</code>");
  });
});

describe("highlight", () => {
  it("only tokens become elements; strings and numbers use the readable orange", () => {
    const nodes = highlight('const n = 42; // done');
    const els = nodes.filter(isValidElement) as ReactElement<{ className: string; children: string }>[];
    expect(nodes.filter((n) => typeof n === "string")).toEqual([" n = ", "; "]);
    expect(els.map((e) => [e.props.children, e.props.className])).toEqual([
      ["const", "text-accent-ink"],
      ["42", "text-orange-ink"],
      ["// done", "text-ink-3 italic"],
    ]);
  });
});
