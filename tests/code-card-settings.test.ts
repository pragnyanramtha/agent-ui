import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, type SettingKey } from "@/lib/settings-schema";

const values: Record<string, unknown> = {};
vi.mock("@/lib/client/settings", () => ({
  useSetting: (key: SettingKey) => [key in values ? values[key] : DEFAULTS[key], () => {}],
}));

const { CodeCard } = await import("@/components/claude/CodeCard");
const code = (n: number) => Array.from({ length: n }, (_, i) => `const v${i + 1} = "x";`).join("\n") + "\n";
const render = (props: { code: string; label?: string; collapsible?: boolean }) => renderToStaticMarkup(createElement(CodeCard, props));

beforeEach(() => {
  for (const k of Object.keys(values)) delete values[k];
});

describe("CodeCard follows the code block settings", () => {
  it("drops the gutter when line numbers are off", () => {
    values.codeLineNumbers = false;
    const html = render({ code: code(5), label: "ts" });
    expect(html).not.toContain("select-none");
    expect(html).toContain("v5");
  });

  it("wraps with a row per line, numbered when line numbers are on", () => {
    values.codeWrap = true;
    const html = render({ code: code(3), label: "ts" });
    expect(html.match(/whitespace-pre-wrap/g)).toHaveLength(3);
    expect(html).not.toContain("<pre");
    expect(html.match(/select-none[^>]*>\d</g)).toHaveLength(3);
    values.codeLineNumbers = false;
    expect(render({ code: code(3), label: "ts" })).not.toContain("select-none");
  });

  it("collapses at the chosen length, only where collapsible", () => {
    values.codeCollapse = "20";
    const html = render({ code: code(41), label: "ts", collapsible: true });
    expect(html).toContain("Show all 41 lines");
    expect(html).toContain("v20");
    expect(html.split("data-code-rest")[0]).not.toContain("v21");
    expect(render({ code: code(41), label: "ts" })).not.toContain("Show all");
  });

  it("never collapses when set to Never", () => {
    values.codeCollapse = "off";
    expect(render({ code: code(500), label: "ts", collapsible: true })).not.toContain("Show all");
  });
});
