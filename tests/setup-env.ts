import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Server modules read these paths at import time, so tests must never see the real ~/.config/agent-u
 * (profiles there add their own session roots and state). Tests that need their own still override them. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-u-test-"));
process.env.AGENT_U_HOME ??= dir;
process.env.AGENT_U_CONFIG ??= path.join(dir, "config.json");
