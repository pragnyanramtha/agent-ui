import { describe, expect, it } from "vitest";
import { PREVIEW_CSP, withPreviewCsp } from "@/lib/client/html-preview";

const META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

describe("HTML preview CSP", () => {
  it("blocks every network load and allows only inline script and style", () => {
    expect(PREVIEW_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; script-src 'unsafe-inline'");
  });

  it("goes first, or right after a doctype so the page keeps standards mode", () => {
    expect(withPreviewCsp("<p>hi</p>")).toBe(`${META}<p>hi</p>`);
    expect(withPreviewCsp("<!DOCTYPE html>\n<html><head><title>x</title>")).toBe(`<!DOCTYPE html>${META}\n<html><head><title>x</title>`);
    expect(withPreviewCsp("\uFEFF  <!doctype html><p>")).toBe(`\uFEFF  <!doctype html>${META}<p>`);
  });

  it("isn't pushed after the page's own content by a doctype further down", () => {
    expect(withPreviewCsp("<script>fetch('//x')</script><!doctype html>")).toBe(`${META}<script>fetch('//x')</script><!doctype html>`);
  });
});
