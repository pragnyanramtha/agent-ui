import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: { include: ["tests/**/*.test.ts"], setupFiles: ["tests/setup-env.ts"], environment: "node", testTimeout: 20_000, pool: "forks" },
});
