import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };

const git = (...args: string[]) => {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};

/* shown in Settings > About; deploys ship `git archive` without .git, so AGENT_U_COMMIT can name the commit instead */
const buildCommit = () => process.env.AGENT_U_COMMIT?.slice(0, 12) || git("rev-parse", "--short=9", "HEAD");

/* only the public GitHub path: remotes can carry credentials */
const repoUrl = () => {
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(git("remote", "get-url", "origin"));
  return m ? `https://github.com/${m[1]}` : "";
};

const nextConfig: NextConfig = {
  poweredByHeader: false,
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version, NEXT_PUBLIC_BUILD_COMMIT: buildCommit(), NEXT_PUBLIC_REPO_URL: repoUrl() },
  /* SSE must not sit in a gzip buffer; Cloudflare compresses at the edge anyway */
  compress: false,
  images: { unoptimized: true },
  /* the SDK spawns the claude binary from its own package dir; bundling it would break that lookup */
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  experimental: { optimizePackageImports: ["iconoir-react"] },
  async headers() {
    const common = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    return [
      /* file bytes set their own, stricter policy (sandboxed, no script) in the route */
      { source: "/api/files/raw", headers: common },
      {
        source: "/((?!api/files/raw).*)",
        headers: [...common, { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" }],
      },
    ];
  },
};

export default nextConfig;
