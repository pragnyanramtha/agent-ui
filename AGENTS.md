# agent-u

Self-hosted, mobile-friendly web UI for coding-agent CLI sessions running on a server (Claude Code first; Codex,
OpenCode, Cursor CLI, Devin CLI, Kimi Code, Gemini CLI and Antigravity through adapters). Built on Beautiful UI (Next.js 15, React 19, Tailwind v4, pnpm).
Watch live sessions, type into the terminal they run in, start/resume sessions from the browser, and open a full web terminal.

## Commands
- `pnpm install` / `pnpm dev` (127.0.0.1:3311) / `pnpm build` / `pnpm start`
- `pnpm typecheck` before every commit
- `printf 'password\n' | node scripts/hash-password.mjs` prints a `UI_PASSWORD_HASH=` line
- `scripts/deploy.sh` ships the committed code (`git archive HEAD`) to the server, builds, restarts (reads `.env.deploy`)
- `scripts/setup.sh` does the whole server setup below and is safe to rerun (see "Setting up for a user")

## Configuration
All machine-specific values live in gitignored env files; `.env.example` documents every key.
- `.env.local` on the server (chmod 600): `UI_PASSWORD` (plain) or `UI_PASSWORD_HASH` (`scrypt:salt:hash`, colon-separated
  because Next's dotenv expands `$`; wins if both are set), `UI_SECRET` (32+ chars, signs the session cookie), optional `CLAUDE_BIN`, `CLAUDE_HOME`, `HIDE_PROJECTS`,
 `IDLE_REAP_MS`, `PTY_PORT`, and per-agent overrides (`CODEX_BIN`, `CODEX_HOME`, `CODEX_WEB_DRIVER`, `OPENCODE_BIN`,
 `OPENCODE_DB`, `CURSOR_AGENT_BIN`, `CURSOR_CONFIG_DIR`, `DEVIN_BIN`, `KIMI_BIN`, `KIMI_CODE_HOME`, `GEMINI_BIN`, `GEMINI_CLI_HOME`, `GEMINI_API_KEY`, `AGY_BIN`), `AGENT_U_HOME`,
 `AGENT_U_CONFIG`, `SHELL_IDLE_MS`, `PUBLIC_HOSTNAME` (written by `scripts/setup.sh`) and `ALLOWED_HOSTS` (comma list of
 other names the site is reached by, `host` or `host:port`; see Security model), `TRUST_PROXY_HEADERS` (`1` behind the
 tunnel, also written by setup.sh), plus any secrets profiles reference as `${NAME}`.
- `.env.deploy` on your machine: `DEPLOY_SSH`, `DEPLOY_SSH_PORT`, `DEPLOY_DIR`, `PUBLIC_HOSTNAME`, `TUNNEL_NAME`.
- Optional, also on your machine and gitignored: `.env.server` (KEY=value lines `scripts/setup.sh` merges into the server's
 `.env.local`) and `agent-u.config.json` (the profiles file it installs).
- Profiles (`~/.config/agent-u/config.json` on the server, chmod 600; editable in the UI under Agents and terminals):
 each is an agent CLI with its own binary, flags, environment and models. Built-ins exist per installed agent under its
 own id; a stored profile with that id overrides it. This is how subscriptions, second accounts, proxies and wrappers
 (for example `codx`, a Codex with another backend) are added without code changes:
 ```json
 { "profiles": [
   { "id": "codx", "label": "Codex (codx)", "agent": "codex", "bin": "codx", "fallback": ["codex"] },
   { "id": "codex-proxy", "label": "Codex via proxy", "agent": "codex", "args": ["-c", "model_provider=\"proxy\""],
     "env": { "OPENAI_API_KEY": "${PROXY_KEY}" }, "models": ["gpt-5.5"] },
   { "id": "claude-work", "label": "Claude (work)", "agent": "claude", "env": { "CLAUDE_CONFIG_DIR": "${HOME}/.claude-work" } },
   { "id": "claude-proxy", "label": "Claude via proxy", "agent": "claude",
     "env": { "ANTHROPIC_BASE_URL": "https://proxy.example/v1", "ANTHROPIC_AUTH_TOKEN": "${CLAUDE_PROXY_KEY}" } }
 ] }
 ```
 Fields: `id` (lowercase, `.`, `_`, `-`), `label`, `agent` (claude, codex, opencode, cursor, devin, kimi, gemini, antigravity), `bin` (name on PATH
 or absolute path), `args` (before the agent's own), `env` (`${VAR}` reads the server environment, so keys stay in
 `.env.local`), `models` (offered in the composer; first is default unless `defaultModel`), `fallback` (profile ids tried in
 order when a turn hits a usage limit), `launchArgs` (interactive launches only), `hidden`, `notes`.
- Never commit hostnames, IPs, ports, tunnel ids, passwords or keys.

## Setting up for a user
When asked to set agent-u up on a server, you only need the ssh target and which subscriptions, proxies or wrappers to use:
1. Write `.env.deploy` (ssh target, port, `DEPLOY_DIR`, and `PUBLIC_HOSTNAME`/`TUNNEL_NAME` if they want a public URL).
2. Write `agent-u.config.json` with one profile per subscription, account, proxy or wrapper, and `.env.server` with the
   secrets those profiles reference. Never put keys in the repo or in profile files directly.
3. Run `SETUP_PASSWORD='...' scripts/setup.sh`. It reports missing tools (install them and rerun), ships and builds the
   code, writes `.env.local`, installs profiles and the systemd units, enables linger, starts the tunnel if it exists, and
   lists which agents still need a login. Install tmux on the server so agents started from the browser survive restarts.
4. Tunnel creation and agent logins need a browser once: `cloudflared tunnel login` / `create` and each CLI's login, run
   over ssh or from the web UI (Agents and terminals > Shell). Rerun `scripts/setup.sh` afterwards.
5. Check `https://$PUBLIC_HOSTNAME/login` answers 200. After that the server runs everything; the user's laptop can be off.

## Server setup (manual, what setup.sh does)
Requirements on the server: Node 22+ (24 recommended), pnpm, python3 (web terminal), the agent CLIs you use
(`claude`, `codex`, `opencode`, `cursor-agent`, `devin`, `kimi`, `gemini`, `agy`), tmux (recommended) or zellij, and `cloudflared` for public access.
1. `scripts/deploy.sh` (copies code, installs, builds). First time, also create `.env.local` in `DEPLOY_DIR` from `.env.example`.
2. Install the user units from `deploy/` into `~/.config/systemd/user/`: `agent-u.service` (app on 127.0.0.1:3311),
   `agent-u-pty.service` (web terminal backend on 127.0.0.1:3312). `systemctl --user daemon-reload && systemctl --user enable --now agent-u agent-u-pty`.
   Run `loginctl enable-linger <user>` so user services survive logout and reboot.
3. Public URL: never expose the ports directly. Use a Cloudflare named tunnel (quick tunnels can't stream GET SSE):
   `cloudflared tunnel create $TUNNEL_NAME`, `cloudflared tunnel route dns $TUNNEL_NAME $PUBLIC_HOSTNAME`, copy the credentials
   JSON to the server's `~/.cloudflared/`, write `~/.cloudflared/agent-u.yml` from `deploy/cloudflared.example.yml`
   (routes `^/pty` to the terminal backend, everything else to the app), and enable `deploy/agent-u-tunnel.service`.
4. Codex sandbox on Ubuntu 24.04+: install `deploy/apparmor-codex-bwrap` as `/etc/apparmor.d/codex-bwrap` (fill in the user)
   and `sudo apparmor_parser -r` it, otherwise workspace-write mode fails with bwrap uid-map/loopback errors.
5. Agent logins happen on the server in a terminal (or the web terminal): `claude` (login), `codex login`,
   `opencode auth login`, `cursor-agent login`, `devin` login, `kimi` then `/login`, `agy` once (signs in interactively).
   `gemini` needs `GEMINI_API_KEY` in `.env.local` (or Vertex AI / Code Assist settings): Google account sign-in moved to Antigravity.

## Security model
- One password for everything; the site can open a shell on the server, so treat the password like an SSH key.
- Middleware gates every page and API route on the signed `cui_session` cookie (HttpOnly, SameSite=strict, Secure behind
  HTTPS); state-changing API calls also need a same-origin `Origin`. Login is rate limited (`lib/server/login-limit.ts`):
  8 attempts per 15 minutes per client and 30 failures per 10 minutes overall. Clients are told apart by
  `cf-connecting-ip` (IPv6 by /64) only with `TRUST_PROXY_HEADERS=1`; otherwise they share one bucket.
- Host allowlist against DNS rebinding (`lib/hosts.ts`, copied in `server/pty.mjs`): only loopback names, `PUBLIC_HOSTNAME`
  and `ALLOWED_HOSTS` are answered; other Hosts get 421 and the WebSocket is refused. With neither variable set (servers
  set up before this existed) any Host is accepted and a warning is logged; rerun `scripts/setup.sh` or set one.
- The web terminal backend (`server/pty.mjs`) re-checks the Host, cookie and origin on the WebSocket upgrade.
- `UI_SECRET`, `UI_PASSWORD` and `UI_PASSWORD_HASH` never reach child processes: every spawn takes its env from
  `lib/server/child-env.ts`, profiles can't expand them, and `server/pty.mjs` drops them from its own env at startup
  (and from the global env of a tmux server it reuses). Session cookies expiring more than 30 days out are refused.
- The cookie HMAC covers the expiry, a session epoch (`auth.json` next to `config.json`, chmod 600) and the password, so
  changing the password or "Sign out everywhere" (`POST /api/auth/logout` with `{"everywhere": true}`, which writes a new
  epoch) ends every session; the terminal backend reads the same file and closes sockets whose session ended.
- Consider Cloudflare Access (email OTP) in front of the hostname for a second factor.

## Architecture notes
- Transcripts (`~/.claude/projects/*/*.jsonl`) are the source of truth for history; `lib/server/tail.ts` streams appends.
- Live terminal sessions come from `~/.claude/sessions/<pid>.json` (pid + start time checked).
- Web runs (`lib/server/runner.ts`, Claude Agent SDK) only add deltas, status, and approvals.
- One agent process per session, never a copy: `POST /api/sessions/[id]/message` routes to the live web run, else types into
  the zellij/tmux pane (`lib/server/input.ts`, checks Claude's prompt first: agent focus, unsent text, dialogs), else resumes.
- Live stream is `POST /api/sessions/[id]/events` read with fetch (SSE framing, `id:` = resume offset, 40s stall reconnect).
- Messages sent while Claude is mid-turn land in the transcript as `attachment` records (`queued_command`).
- Other agents: `lib/server/agents/<agent>.ts` implement `AgentAdapter` (`lib/server/agents/types.ts`) and emit the same
  `Entry` stream; session ids are `<agent>:<nativeId>` (plain ids are Claude, so old links keep working). Web-driven turns use
  each CLI's own driver via `lib/server/agents/cli-run.ts` (which also carries live `live:` text deltas). Route glue in
  `lib/server/agents/routes.ts`. Codex turns use `codex app-server` (JSON-RPC, streams; `CODEX_WEB_DRIVER=exec` falls back
  to `codex exec --json`); OpenCode turns start a private `opencode serve` and `opencode run --attach` (its `/event` stream
  gives deltas); Cursor uses `cursor-agent -p --output-format stream-json --stream-partial-output`; Devin streams stdout of
  `devin -p`; Gemini CLI runs `gemini -p "" --output-format stream-json` (prompt on stdin, `--session-id <our uuid>` or
  `--resume`, history folded from `~/.gemini/tmp/<project>/chats/*.jsonl`); Antigravity runs `agy -p --output-format
  stream-json` (`--conversation` to continue; list from `~/.gemini/antigravity-cli/conversation_summaries.db`, history from
  `brain/<id>/.system_generated/logs/transcript_full.jsonl`). Codex approvals (Ask first, Accept edits) come from the app server and show as cards (`askUser` /
 `answerTurn` in `cli-run.ts`); the other agents' print modes can't ask, so they default to Bypass in the UI.
- Markdown: `components/claude/Markdown.tsx` renders with Streamdown (lazy-loaded; KaTeX only when a message has math;
  raw HTML is never rendered; code blocks use CodeCard). Live text uses the same renderer in streaming mode.
- Shell: harness-style tabs (`components/claude/useTabs.ts`, `TabBar.tsx`); only the active tab's session is mounted.
- Web terminal: `server/pty.mjs` runs a shell, or attaches to the session's zellij/tmux, on a pty via `server/pty_bridge.py`
  (no native Node module). Terminals are kept on the server: closing the tab or losing the network only detaches, and
  reattaching replays the screen. `POST /internal/launch` (HMAC of `UI_SECRET` in `x-agent-u-internal`) starts an agent's
  own TUI in an `agentu-*` tmux session when tmux exists (survives `agent-u-pty` restarts), else on a plain pty.
  `lib/server/terminals.ts` builds each agent's resume and model flags; `/api/terminals` lists, launches and stops them.
  xterm uses JetBrains Mono plus Symbols Nerd Font Mono, WebGL and Unicode 11.
- Profiles: `lib/server/profiles.ts` (config, `${VAR}` expansion, masked secrets in the API); `withProfile` (AsyncLocalStorage)
  makes adapters spawn the profile's binary, args and env. `state.json` remembers which profile each session uses.
- Handoff ("Continue in another agent"): `lib/server/handoff.ts`. Into Claude it writes a native transcript and resumes it;
  into Codex it uses app-server `thread/inject_items`; other agents get the compact transcript in the first prompt
  (`lib/server/handoff-shape.ts`, `lib/handoff-text.ts` for how the UI shows it).
- Fallback: `lib/server/fallback.ts` watches each web turn; on a usage limit it resends with the next `fallback` profile if
  it shares the session store, else hands off to it and redirects the client to the new session.
- Flaky networks: sends carry a `clientId` (`lib/server/dedupe.ts` replays the first answer for 15 min), the client retries
  through drops (`lib/client/send.ts`), and history and streams back off and resume on `online` or tab focus.
- Files: `/api/files` (list, read, mkdir, rename, delete, write), `/api/files/raw` (Range downloads; served with a sandbox
  CSP so HTML artifacts can't reach the app), `/api/files/upload` (8 MB resumable chunks; excluded from the middleware
  matcher because middleware buffers bodies, so it calls `guard()` itself).
- Notifications: `lib/server/notify.ts` watches session states and sends Web Push (`lib/server/push.ts`, keys and
 subscriptions in `~/.config/agent-u/push.json`); `public/sw.js` shows them. The Inbox view lists approvals (answerable
 inline), failures and turns that finished while you were elsewhere.
- Attachments: uploaded to `~/.cache/agent-u/attachments/<day>-<id>/` and named by path at the end of the message
 (`lib/attachments.ts`), so every agent and terminal can open them; the thread renders them as thumbnails.
- Git (`lib/server/git.ts`): a checkpoint of the working tree before each web message (hidden refs under
 `refs/agent-u/cp/`, via a temporary index: HEAD, branch and staging area untouched), rewind with undo, commit/push/PR
 (gh), and optional worktree per new session (`~/.local/share/agent-u/worktrees`).
- UI copy: no em dashes; loading labels end with an ellipsis.
