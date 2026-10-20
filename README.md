# agent-ui

A self-hosted, mobile-friendly web UI for coding-agent sessions running on your own server: Claude Code, with
adapters for Codex, OpenCode, Cursor CLI, Devin CLI, Kimi Code, Gemini CLI and Antigravity.

- Live view of sessions running in zellij/tmux, and typing into them from your phone
- Start and resume sessions from the browser (Claude Agent SDK, other CLIs' non-interactive modes)
- Tool calls, diffs, approvals, a changes panel, context usage, and a command palette
- A full web terminal (shell, or attach to the session's zellij/tmux)
- Password login, signed cookies, meant to sit behind a Cloudflare tunnel

Built on [Beautiful UI](https://www.beautifului.dev/) (Next.js 15, React 19, Tailwind v4).

Setup, configuration, deployment and architecture are in [AGENTS.md](AGENTS.md); every environment variable is
documented in [.env.example](.env.example).

MIT licensed.
