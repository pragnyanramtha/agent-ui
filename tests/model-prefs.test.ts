import { describe, expect, it } from "vitest";
import { arrangeModels, parseModelList, toggleModel } from "@/lib/model-prefs";

const MODELS = [
  { key: "", name: "Default" },
  { key: "gpt-5.5", name: "GPT-5.5" },
  { key: "gpt-5.5-mini", name: "GPT-5.5 mini" },
  { key: "o9", name: "o9" },
  { key: "codex-max", name: "Codex Max" },
];
const keys = (r: { rows: { key: string }[] }) => r.rows.map((m) => m.key);

describe("favorite and hidden model lists", () => {
  it("reads commas, spaces and new lines, once each", () => {
    expect(parseModelList(" gpt-5.5,o9\n o9 ,, opus ")).toEqual(["gpt-5.5", "o9", "opus"]);
    expect(parseModelList("")).toEqual([]);
  });

  it("toggles one id in or out", () => {
    expect(toggleModel("", "o9")).toBe("o9");
    expect(toggleModel("o9", "opus")).toBe("o9, opus");
    expect(toggleModel("o9, opus", "o9")).toBe("opus");
  });
});

describe("arranging the model picker", () => {
  it("keeps the list as is with nothing set", () => {
    expect(arrangeModels(MODELS, { favorites: "", hidden: "" })).toEqual({ rows: MODELS, hiddenCount: 0 });
  });

  it("puts Default first, then favorites in list order, then the rest", () => {
    expect(keys(arrangeModels(MODELS, { favorites: "codex-max, gpt-5.5-mini", hidden: "" }))).toEqual(["", "gpt-5.5-mini", "codex-max", "gpt-5.5", "o9"]);
  });

  it("ignores favorites the list doesn't have", () => {
    expect(keys(arrangeModels(MODELS, { favorites: "opus", hidden: "" }))).toEqual(MODELS.map((m) => m.key));
  });

  it("leaves hidden models out, but never Default or the current model", () => {
    const r = arrangeModels(MODELS, { favorites: "", hidden: "o9, gpt-5.5, " }, { current: "gpt-5.5" });
    expect(keys(r)).toEqual(["", "gpt-5.5", "gpt-5.5-mini", "codex-max"]);
    expect(r.hiddenCount).toBe(1);
    expect(keys(arrangeModels(MODELS, { favorites: "", hidden: "" }, { current: "" }))).toContain("");
  });

  it("shows hidden ones on request and when filtering, still favorites first", () => {
    expect(keys(arrangeModels(MODELS, { favorites: "o9", hidden: "o9" }, { showHidden: true }))).toEqual(["", "o9", "gpt-5.5", "gpt-5.5-mini", "codex-max"]);
    const found = arrangeModels(MODELS, { favorites: "gpt-5.5-mini", hidden: "gpt-5.5-mini" }, { query: "mini" });
    expect(keys(found)).toEqual(["", "gpt-5.5-mini"]);
    expect(found.hiddenCount).toBe(0);
  });

  it("filters by id or name and keeps the current model", () => {
    expect(keys(arrangeModels(MODELS, { favorites: "", hidden: "" }, { query: "MAX", current: "o9" }))).toEqual(["", "o9", "codex-max"]);
  });
});
