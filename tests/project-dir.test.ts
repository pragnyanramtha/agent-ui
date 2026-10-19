import { describe, expect, it } from "vitest";
import { projectDirName } from "@/lib/server/config";

/* Expected names come from running the Agent SDK's own function (sdk.mjs, 0.3.289) on the same paths. */
describe("Claude project folder names", () => {
  it("short paths: every non-alphanumeric char becomes a dash", () => {
    expect(projectDirName("/w")).toBe("-w");
    expect(projectDirName("/home/u/my_app.v2")).toBe("-home-u-my-app-v2");
  });

  it("names over 200 chars are cut and get the hash of the full path", () => {
    const a = projectDirName(`/home/u/${"a".repeat(250)}`);
    expect(a).toBe(`-home-u-${"a".repeat(192)}-bkw3mj`);
    expect(projectDirName(`/srv/projects/${"deep/".repeat(60)}app`).slice(195)).toBe("eep-d-tvo9gt");
    expect(projectDirName(`/home/ünï/${"x".repeat(300)}`).slice(195)).toBe("xxxxx-7phgxf");
  });

  it("two long paths sharing the first 200 chars get different folders", () => {
    const base = `/home/u/${"b".repeat(220)}`;
    expect(projectDirName(`${base}/one`)).not.toBe(projectDirName(`${base}/two`));
  });
});
