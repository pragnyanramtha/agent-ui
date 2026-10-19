import fs from "node:fs";
import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import rehypeRaw from "@/lib/client/rehype-raw-stub";

type Alias = Record<string, string>;
const run = (isServer: boolean) => (nextConfig.webpack as (c: unknown, o: unknown) => { resolve: { alias: Alias } })({ resolve: { alias: { keep: "x" } } }, { isServer });

describe("rehype-raw stub", () => {
  it("replaces rehype-raw in the browser bundle only", () => {
    const client = run(false).resolve.alias;
    expect(client.keep).toBe("x");
    expect(fs.existsSync(client["rehype-raw$"])).toBe(true);
    expect(run(true).resolve.alias["rehype-raw$"]).toBeUndefined();
  });

  it("is a plugin that adds no transform", () => {
    expect(rehypeRaw()).toBeUndefined();
  });
});
