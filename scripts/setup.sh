#!/usr/bin/env bash
# One-time (and safe to repeat) server setup: checks requirements, ships and builds the code,
# writes .env.local, installs the agent profiles, the systemd user units and, when the tunnel
# exists, the Cloudflare tunnel. Everything machine-specific comes from gitignored local files:
#   .env.deploy          DEPLOY_SSH, DEPLOY_SSH_PORT, DEPLOY_DIR, PUBLIC_HOSTNAME, TUNNEL_NAME
#   .env.server          optional KEY=value lines merged into the server's .env.local (proxy keys, CODEX_HOME, ...)
#   agent-u.config.json  optional profiles file, copied to ~/.config/agent-u/config.json
# SETUP_PASSWORD=... sets the login password; without it a new .env.local gets a random one, printed once.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.deploy ] || { echo "Missing .env.deploy (copy the Deploy section of .env.example)" >&2; exit 1; }
set -a; . ./.env.deploy; set +a
SSH=(ssh -p "${DEPLOY_SSH_PORT:-22}" -o BatchMode=yes -o ConnectTimeout=15 "$DEPLOY_SSH")
DIR="${DEPLOY_DIR:-agent-u}"
case "$DIR" in /*) echo "DEPLOY_DIR must be relative to the remote home" >&2; exit 1 ;; esac
step() { printf '\n== %s\n' "$*"; }

step "Connecting to $DEPLOY_SSH"
"${SSH[@]}" true || { echo "ssh failed; check DEPLOY_SSH, DEPLOY_SSH_PORT and that your key is authorized" >&2; exit 1; }

step "Checking the server"
"${SSH[@]}" 'export PATH=$HOME/.local/bin:$HOME/.local/npm-global/bin:$HOME/.npm-global/bin:$HOME/.opencode/bin:$HOME/.kimi-code/bin:$HOME/.bun/bin:/usr/local/bin:$PATH
  miss=0
  node -e "process.exit(parseInt(process.versions.node) < 22 ? 1 : 0)" 2>/dev/null && echo "ok   node $(node -v)" || { echo "MISSING node 22+ (24 recommended)"; miss=1; }
  command -v pnpm >/dev/null && echo "ok   pnpm" || { echo "MISSING pnpm (corepack enable pnpm, or npm i -g pnpm)"; miss=1; }
  command -v python3 >/dev/null && echo "ok   python3" || { echo "MISSING python3 (the web terminal needs it)"; miss=1; }
  command -v tmux >/dev/null && echo "ok   tmux" || echo "note tmux not found: agents started from the browser then stop when agent-u-pty restarts"
  command -v cloudflared >/dev/null && echo "ok   cloudflared" || echo "note cloudflared not found: no public URL until it is installed"
  for b in claude codex opencode cursor-agent devin kimi gemini agy; do command -v $b >/dev/null && echo "ok   $b" || echo "--   $b not installed"; done
  exit $miss' || { echo "Install the missing tools on the server, then run this again." >&2; exit 1; }

step "Shipping the code to ~/$DIR"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then echo "Note: uncommitted changes are not shipped." >&2; fi
git archive HEAD | "${SSH[@]}" "mkdir -p \"\$HOME/$DIR\" && cd \"\$HOME/$DIR\" && tar -x"

step "Writing .env.local"
HASH=""
if [ -n "${SETUP_PASSWORD:-}" ]; then HASH=$(printf '%s\n' "$SETUP_PASSWORD" | node scripts/hash-password.mjs | sed 's/^UI_PASSWORD_HASH=//'); fi
EXTRA=""; [ -f .env.server ] && EXTRA=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env.server || true)
EXTRA64=$(printf '%s\n' "$EXTRA" | base64 | tr -d '\n')
"${SSH[@]}" "HASH='$HASH' DIR='$DIR' EXTRA64='$EXTRA64' PUBLIC='${PUBLIC_HOSTNAME:-}' bash -s" <<'REMOTE'
set -euo pipefail
f="$HOME/$DIR/.env.local"
extra=$(printf '%s' "$EXTRA64" | base64 -d)
umask 077
touch "$f"; chmod 600 "$f"
set_key() { # replaces KEY=... or appends it
  local k="$1" v="$2" tmp; tmp=$(mktemp)
  grep -v "^$k=" "$f" > "$tmp" || true
  printf '%s=%s\n' "$k" "$v" >> "$tmp"
  cat "$tmp" > "$f"; rm -f "$tmp"
}
grep -q '^UI_SECRET=.\{32,\}' "$f" || set_key UI_SECRET "$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/')"
if [ -n "$HASH" ]; then
  set_key UI_PASSWORD_HASH "$HASH"; sed -i '/^UI_PASSWORD=/d' "$f"; echo "password set"
elif ! grep -q '^UI_PASSWORD\(_HASH\)\?=.' "$f"; then
  pw=$(head -c 18 /dev/urandom | base64 | tr -d '\n=+/')
  set_key UI_PASSWORD "$pw"
  echo "New login password (shown once, change it with SETUP_PASSWORD=...): $pw"
fi
# the app and the terminal backend only answer this name (plus loopback and ALLOWED_HOSTS)
if [ -n "$PUBLIC" ]; then set_key PUBLIC_HOSTNAME "$PUBLIC"; fi
while IFS= read -r line; do [ -n "$line" ] && set_key "${line%%=*}" "${line#*=}"; done <<< "$extra"
echo "$(grep -c . "$f") keys in $f"
REMOTE

if [ -f agent-u.config.json ]; then
  step "Installing agent profiles"
  node -e 'const c=JSON.parse(require("fs").readFileSync("agent-u.config.json","utf8")); if(!Array.isArray(c.profiles)) throw new Error("agent-u.config.json needs a profiles array"); console.log(c.profiles.map(p=>p.id).join(", "))'
  "${SSH[@]}" 'd=${AGENT_U_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-u}; mkdir -p "$d" && umask 077 && cat > "$d/config.json.tmp" && mv "$d/config.json.tmp" "$d/config.json" && chmod 600 "$d/config.json" && echo "wrote $d/config.json"' < agent-u.config.json
fi

step "Building"
"${SSH[@]}" "export PATH=\$HOME/.local/bin:\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  cd \"\$HOME/$DIR\" && pnpm install --frozen-lockfile >/dev/null && pnpm build 2>&1 | grep -E 'Compiled|rror' || { echo 'build failed' >&2; exit 1; }"

step "Installing the systemd user units"
for u in agent-u agent-u-pty; do
  sed "s#%h/agent-u#%h/$DIR#g" "deploy/$u.service" | "${SSH[@]}" "mkdir -p ~/.config/systemd/user && n=\$(command -v node) && sed \"s#/usr/bin/node#\$n#\" > ~/.config/systemd/user/$u.service"
done
"${SSH[@]}" 'systemctl --user daemon-reload && systemctl --user enable agent-u agent-u-pty >/dev/null 2>&1 && systemctl --user restart agent-u agent-u-pty
  loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes || loginctl enable-linger "$USER" 2>/dev/null || echo "Run once as root so the services outlive your login: sudo loginctl enable-linger $USER"
  sleep 4; systemctl --user is-active agent-u agent-u-pty
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3311/login || true); echo "app answers $code on 127.0.0.1:3311"
  [ "$code" = 200 ] || { journalctl --user -u agent-u -n 20 --no-pager; exit 1; }'

if [ -n "${TUNNEL_NAME:-}" ] && [ -n "${PUBLIC_HOSTNAME:-}" ]; then
  step "Cloudflare tunnel $TUNNEL_NAME for $PUBLIC_HOSTNAME"
  "${SSH[@]}" "TUNNEL='$TUNNEL_NAME' HOST='$PUBLIC_HOSTNAME' bash -s" <<'REMOTE' || echo "Tunnel not set up yet; see Server setup step 3 in AGENTS.md, then run this again."
set -euo pipefail
command -v cloudflared >/dev/null || { echo "cloudflared is not installed"; exit 1; }
id=$(cloudflared tunnel list -o json 2>/dev/null | python3 -c 'import json,sys,os; t=[x for x in json.load(sys.stdin) if x["name"]==os.environ["TUNNEL"]]; print(t[0]["id"] if t else "")' 2>/dev/null || true)
if [ -z "$id" ] && [ -f "$HOME/.cloudflared/agent-u.yml" ]; then echo "Keeping the existing ~/.cloudflared/agent-u.yml (no cloudflared login here to look tunnels up)"; exit 0; fi
[ -n "$id" ] || { echo "No tunnel named $TUNNEL (needs cloudflared tunnel login + create, which open a browser)"; exit 1; }
[ -f "$HOME/.cloudflared/$id.json" ] || { echo "Missing credentials ~/.cloudflared/$id.json"; exit 1; }
cat > "$HOME/.cloudflared/agent-u.yml" <<EOF
tunnel: $id
credentials-file: $HOME/.cloudflared/$id.json
no-autoupdate: true
ingress:
  - hostname: $HOST
    path: ^/pty
    service: http://127.0.0.1:3312
  - hostname: $HOST
    service: http://127.0.0.1:3311
  - service: http_status:404
EOF
cloudflared tunnel route dns "$TUNNEL" "$HOST" >/dev/null 2>&1 || true
REMOTE
  if "${SSH[@]}" 'test -f ~/.cloudflared/agent-u.yml'; then
    sed "s#/usr/bin/cloudflared#CLOUDFLARED#" deploy/agent-u-tunnel.service | "${SSH[@]}" 'n=$(command -v cloudflared) && sed "s#CLOUDFLARED#$n#" > ~/.config/systemd/user/agent-u-tunnel.service && systemctl --user daemon-reload && systemctl --user enable agent-u-tunnel >/dev/null 2>&1 && systemctl --user restart agent-u-tunnel && sleep 3 && systemctl --user is-active agent-u-tunnel'
    code=$(curl -s -o /dev/null -w "%{http_code}" "https://$PUBLIC_HOSTNAME/login" || true)
    echo "https://$PUBLIC_HOSTNAME/login answers $code"
  fi
fi

step "Agent logins"
"${SSH[@]}" 'export PATH=$HOME/.local/bin:$HOME/.local/npm-global/bin:$HOME/.npm-global/bin:$HOME/.opencode/bin:$HOME/.kimi-code/bin:/usr/local/bin:$PATH
  [ -d ~/.claude ] && ls ~/.claude/.credentials.json >/dev/null 2>&1 && echo "claude: credentials found" || { command -v claude >/dev/null && echo "claude: run claude, then /login"; }
  command -v codex >/dev/null && { codex login status >/dev/null 2>&1 && echo "codex: credentials found" || echo "codex: run codex login"; }
  command -v opencode >/dev/null && echo "opencode: opencode auth login if not done"
  command -v cursor-agent >/dev/null && { cursor-agent status 2>/dev/null | grep -qi "logged in" && echo "cursor: credentials found" || echo "cursor: run cursor-agent login"; }
  command -v kimi >/dev/null && echo "kimi: run kimi, then /login if not done"
  command -v gemini >/dev/null && { [ -n "$GEMINI_API_KEY$GOOGLE_API_KEY" ] || grep -qs "^GEMINI_API_KEY=." "$HOME/'"$DIR"'/.env.local" && echo "gemini: API key found" || echo "gemini: set GEMINI_API_KEY in .env.local (or Vertex AI / Code Assist); Google sign-in moved to Antigravity"; }
  command -v agy >/dev/null && { [ -f ~/.gemini/antigravity-cli/conversation_summaries.db ] && echo "antigravity: has run before; run agy once if turns say it is not signed in" || echo "antigravity: run agy once to sign in"; }
  true'
echo
echo "Found credentials can still be expired: if a turn says the login or token expired, log in again on the server."
echo "Done. Logins happen on the server: over ssh, or in the browser under Agents and terminals > Shell."
