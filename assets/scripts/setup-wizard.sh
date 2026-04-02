#!/usr/bin/env bash
set -euo pipefail

# Minion Setup Wizard
# Creates a new minion instance backed by @tprei/telegram-minions

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RESET="\033[0m"

step() { echo -e "\n${CYAN}==>${RESET} ${BOLD}$1${RESET}"; }
info() { echo -e "    $1"; }
success() { echo -e "${GREEN}✓${RESET} $1"; }
warn() { echo -e "${YELLOW}!${RESET} $1"; }

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "Error: $1 is required but not installed"
    exit 1
  fi
}

update_image() {
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PKG_ASSETS="$SCRIPT_DIR/.."
  PROJECT_DIR="${1:-.}"

  if [[ ! -f "$PROJECT_DIR/fly.toml" ]]; then
    echo "Error: no fly.toml found in $PROJECT_DIR — run from a minion project directory"
    exit 1
  fi

  MINION_NAME=$(grep '^app\s*=' "$PROJECT_DIR/fly.toml" | head -1 | sed 's/.*=\s*"\?\([^"]*\)"\?/\1/' | xargs)

  step "Updating Docker image for $MINION_NAME"

  generate_dockerfile "$PROJECT_DIR"
  success "Dockerfile"

  cp "$PKG_ASSETS/templates/entrypoint.sh" "$PROJECT_DIR/entrypoint.sh"
  chmod +x "$PROJECT_DIR/entrypoint.sh"
  success "entrypoint.sh"

  if [[ -d "$PKG_ASSETS/agents" ]]; then
    mkdir -p "$PROJECT_DIR/.claude/agents"
    cp -r "$PKG_ASSETS/agents"/* "$PROJECT_DIR/.claude/agents/" 2>/dev/null || true
    success "Updated .claude/agents/"
  fi

  if [[ -f "$PKG_ASSETS/settings.json" ]]; then
    cp "$PKG_ASSETS/settings.json" "$PROJECT_DIR/.claude/settings.json"
    success "Updated .claude/settings.json"
  fi

  step "Deploying"
  (cd "$PROJECT_DIR" && fly deploy -a "$MINION_NAME" 2>&1 | tail -10)

  echo -e "\n${GREEN}✓ Image updated and deployed!${RESET}"
  echo -e "  App: ${CYAN}$MINION_NAME${RESET}"
  echo -e "  Dashboard: ${CYAN}https://fly.io/apps/$MINION_NAME${RESET}\n"
}

generate_dockerfile() {
  local dir="$1"
  cat > "$dir/Dockerfile" <<'DOCKERFILE'
FROM ghcr.io/astral-sh/uv:latest AS uv

FROM node:22-slim

RUN apt-get update && apt-get install -y \
  git curl ca-certificates bzip2 libgomp1 \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

ENV UV_PYTHON_INSTALL_DIR="/opt/uv-python"
RUN uv python install 3.13 \
    && chmod -R o+rx /opt/uv-python

RUN apt-get update && apt-get install -y build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/devtools \
    && cd /opt/devtools \
    && npm init -y \
    && npm install --ignore-scripts vitest typescript happy-dom jsdom \
    && rm package.json package-lock.json \
    && node -e "const c=require('crypto');const h=c.createHash('sha256');const fs=require('fs');h.update(fs.readdirSync('/opt/devtools/node_modules').sort().join(','));fs.writeFileSync('/opt/devtools/.version',h.digest('hex'))" \
    && chmod -R o+rx /opt/devtools

ENV UV_TOOL_DIR="/opt/uv-tools"
ENV UV_TOOL_BIN_DIR="/opt/uv-tools/bin"
RUN uv tool install pytest \
    && uv tool install ruff \
    && uv tool install mypy \
    && chmod -R o+rx /opt/uv-tools

RUN curl -fsSL -o /tmp/goose.tar.bz2 \
      https://github.com/block/goose/releases/download/stable/goose-x86_64-unknown-linux-gnu.tar.bz2 \
    && tar -xjf /tmp/goose.tar.bz2 -C /tmp \
    && mv /tmp/goose /usr/local/bin/goose \
    && chmod +x /usr/local/bin/goose \
    && rm /tmp/goose.tar.bz2

RUN npm install -g \
  @anthropic-ai/claude-code \
  @zed-industries/claude-agent-acp \
  @playwright/mcp \
  @upstash/context7-mcp

RUN curl -fsSL -o /tmp/github-mcp-server.tar.gz \
      https://github.com/github/github-mcp-server/releases/latest/download/github-mcp-server_Linux_x86_64.tar.gz \
    && tar -xzf /tmp/github-mcp-server.tar.gz -C /tmp \
    && mv /tmp/github-mcp-server /usr/local/bin/github-mcp-server \
    && chmod +x /usr/local/bin/github-mcp-server \
    && rm /tmp/github-mcp-server.tar.gz

ENV PLAYWRIGHT_BROWSERS_PATH="/opt/pw-browsers"
RUN chmod 1777 /tmp && apt-get update && npx playwright install --with-deps chromium && chmod -R o+rx /opt/pw-browsers && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json .npmrc* ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --production

RUN useradd -m -s /bin/bash minion \
    && chown -R minion:minion /opt/pw-browsers \
    && chown -R minion:minion /opt/uv-python \
    && chown -R minion:minion /opt/devtools \
    && chown -R minion:minion /opt/uv-tools

RUN chmod +x /app/entrypoint.sh /app/scripts/*.sh

CMD ["/app/entrypoint.sh"]
DOCKERFILE
}

main() {
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PKG_ASSETS="$SCRIPT_DIR/.."

  if [[ "${1:-}" == "update-image" ]]; then
    check_cmd fly
    update_image "${2:-}"
    exit 0
  fi

  echo -e "\n${BOLD}╔══════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║       Minion Setup Wizard                ║${RESET}"
  echo -e "${BOLD}║   Powered by @tprei/telegram-minions     ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}\n"

  check_cmd fly
  check_cmd gh
  check_cmd npm

  # --- Gather inputs ---
  step "Configuration"

  read -rp "    Minion name (e.g. my-project-minion): " MINION_NAME
  [[ -z "$MINION_NAME" ]] && { echo "Name required"; exit 1; }

  read -rp "    Fly org (personal/retirers/matheus-266) [personal]: " FLY_ORG
  FLY_ORG="${FLY_ORG:-personal}"

  read -rp "    Target repo URL (e.g. https://github.com/user/repo): " TARGET_REPO
  [[ -z "$TARGET_REPO" ]] && { echo "Repo URL required"; exit 1; }

  REPO_NAME=$(basename "$TARGET_REPO" .git)

  step "Telegram Setup"
  echo -e "    Create a new bot via ${CYAN}@BotFather${RESET}:"
  echo -e "      1. Send ${CYAN}/newbot${RESET}"
  echo -e "      2. Copy the token"
  read -rp "    Bot token: " BOT_TOKEN
  [[ -z "$BOT_TOKEN" ]] && { echo "Bot token required"; exit 1; }

  echo -e "\n    Create a Telegram group and add your bot."
  echo -e "    Get the chat ID by forwarding a message to ${CYAN}@userinfobot${RESET}"
  read -rp "    Chat ID (starts with -100): " CHAT_ID
  [[ -z "$CHAT_ID" ]] && { echo "Chat ID required"; exit 1; }

  read -rp "    Your Telegram user ID: " USER_ID
  [[ -z "$USER_ID" ]] && { echo "User ID required"; exit 1; }

  step "GitHub Token"
  echo -e "    Needs ${CYAN}repo${RESET} and ${CYAN}read:packages${RESET} scopes"
  read -rp "    Use current gh token? [Y/n]: " USE_GH
  if [[ "${USE_GH:-Y}" =~ ^[Yy] ]]; then
    GITHUB_TOKEN=$(gh auth token)
  else
    read -rp "    GitHub token: " GITHUB_TOKEN
  fi

  step "Agent Provider"
  echo -e "    ${CYAN}1.${RESET} Claude Code subscription (claude-acp) - Recommended"
  echo -e "    ${CYAN}2.${RESET} Direct Anthropic API key"
  read -rp "    Choice [1]: " PROVIDER_CHOICE
  PROVIDER_CHOICE="${PROVIDER_CHOICE:-1}"

  if [[ "$PROVIDER_CHOICE" == "2" ]]; then
    read -rp "    Anthropic API key: " ANTHROPIC_KEY
    GOOSE_PROVIDER="anthropic"
    GOOSE_MODEL="claude-opus-4-6"
  else
    ANTHROPIC_KEY=""
    GOOSE_PROVIDER="claude-acp"
    GOOSE_MODEL="default"
  fi

  # --- Create project directory ---
  step "Creating project directory"

  PROJECT_DIR="$MINION_NAME"
  mkdir -p "$PROJECT_DIR"/{src,scripts,.claude/agents}

  success "Created $PROJECT_DIR/"

  # --- Copy agent templates from package ---
  if [[ -d "$PKG_ASSETS/agents" ]]; then
    cp -r "$PKG_ASSETS/agents"/* "$PROJECT_DIR/.claude/agents/" 2>/dev/null || true
    success "Copied agent templates to .claude/agents/"
  else
    warn "Could not find agent templates - create .claude/agents/ manually"
  fi

  if [[ -f "$PKG_ASSETS/settings.json" ]]; then
    cp "$PKG_ASSETS/settings.json" "$PROJECT_DIR/.claude/settings.json"
    success ".claude/settings.json"
  fi

  cat > "$PROJECT_DIR/.claude/CLAUDE.md" <<'CLAUDEMD'
## Project

CLAUDEMD
  success ".claude/CLAUDE.md"

  # --- Generate files ---
  step "Generating files"

  # package.json
  cat > "$PROJECT_DIR/package.json" <<EOF
{
  "name": "$MINION_NAME",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node dist/index.js",
    "build": "tsc",
    "dev": "npx tsx src/index.ts"
  },
  "dependencies": {
    "@tprei/telegram-minions": "^1.0.0",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.9.3"
  }
}
EOF
  success "package.json"

  # .npmrc
  cat > "$PROJECT_DIR/.npmrc" <<EOF
@tprei:registry=https://npm.pkg.github.com
EOF
  success ".npmrc"

  # tsconfig.json
  cat > "$PROJECT_DIR/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
EOF
  success "tsconfig.json"

  # src/index.ts
  cat > "$PROJECT_DIR/src/index.ts" <<EOF
import { createMinion, configFromEnv } from "@tprei/telegram-minions"

const minion = createMinion({
  ...configFromEnv(),
  repos: {
    "target": "$TARGET_REPO",
  },
})

process.on("SIGTERM", () => { minion.stop(); process.exit(0) })
process.on("SIGINT", () => { minion.stop(); process.exit(0) })

process.on("uncaughtException", (err) => {
  process.stderr.write(\`uncaught exception: \${err}\n\`)
  process.exit(1)
})

process.on("unhandledRejection", (reason) => {
  process.stderr.write(\`unhandled rejection: \${reason}\n\`)
  process.exit(1)
})

await minion.start()
EOF
  success "src/index.ts"

  # fly.toml
  cat > "$PROJECT_DIR/fly.toml" <<EOF
app = "$MINION_NAME"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  WORKSPACE_ROOT = "/workspace"
  GOOSE_PROVIDER = "$GOOSE_PROVIDER"
  GOOSE_MODEL = "$GOOSE_MODEL"
  HOME = "/workspace/home"
  IS_SANDBOX = "true"
  ENABLE_BROWSER_MCP = "true"
  PLAYWRIGHT_BROWSERS_PATH = "/opt/pw-browsers"

[[mounts]]
  source = "workspace_data"
  destination = "/workspace"

[[vm]]
  size = "shared-cpu-4x"
  memory = "4gb"
  auto_stop = false
EOF
  success "fly.toml"

  # Dockerfile
  generate_dockerfile "$PROJECT_DIR"
  success "Dockerfile"

  # entrypoint.sh
  cp "$PKG_ASSETS/templates/entrypoint.sh" "$PROJECT_DIR/entrypoint.sh"
  chmod +x "$PROJECT_DIR/entrypoint.sh"
  success "entrypoint.sh"

  # .env.example
  cat > "$PROJECT_DIR/.env.example" <<EOF
# Telegram bot credentials
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=-1001234567890
ALLOWED_USER_IDS=123456789

# Agent — Claude Code subscription (ACP)
GOOSE_PROVIDER=claude-acp
GOOSE_MODEL=default

# GitHub (for repo cloning and MCP)
GITHUB_TOKEN=ghp_...

# Session settings
WORKSPACE_ROOT=/tmp/minions-workspace
MAX_CONCURRENT_SESSIONS=5
SESSION_TIMEOUT_MS=3600000
ACTIVITY_THROTTLE_MS=3000

# MCP servers
ENABLE_BROWSER_MCP=true
ENABLE_GITHUB_MCP=true
ENABLE_CONTEXT7_MCP=true
EOF
  success ".env.example"

  # .gitignore
  cat > "$PROJECT_DIR/.gitignore" <<'EOF'
# Dependencies
node_modules/

# Build output
dist/

# Environment files (secrets)
.env
.env.local
.env.*.local
.npmrc

# IDE
.idea/
.vscode/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
EOF
  success ".gitignore"

  # --- Install dependencies ---
  step "Installing dependencies"

  # Get GitHub token for npm auth
  NPM_TOKEN=$(gh auth token)
  echo "//npm.pkg.github.com/:_authToken=$NPM_TOKEN" >> "$PROJECT_DIR/.npmrc"

  (cd "$PROJECT_DIR" && npm install --cache /tmp/npm-cache 2>&1 | tail -3)
  (cd "$PROJECT_DIR" && npm run build)
  success "Dependencies installed and built"

  # --- Create fly app ---
  step "Creating fly app"

  fly apps create "$MINION_NAME" --org "$FLY_ORG" 2>&1 || {
    warn "App may already exist, continuing..."
  }
  success "Fly app created"

  # --- Create volume ---
  step "Creating persistent volume"

  fly volumes create workspace_data --size 10 -a "$MINION_NAME" -r iad -y 2>&1 || {
    warn "Volume may already exist, continuing..."
  }
  success "Volume created"

  # --- Set secrets ---
  step "Setting secrets"

  SECRETS="TELEGRAM_BOT_TOKEN=$BOT_TOKEN,TELEGRAM_CHAT_ID=$CHAT_ID,ALLOWED_USER_IDS=$USER_ID,GITHUB_TOKEN=$GITHUB_TOKEN"

  if [[ -n "$ANTHROPIC_KEY" ]]; then
    SECRETS="$SECRETS,ANTHROPIC_API_KEY=$ANTHROPIC_KEY"
  fi

  fly secrets set "$SECRETS" -a "$MINION_NAME" 2>&1
  success "Secrets configured"

  # --- Deploy ---
  step "Deploying"

  (cd "$PROJECT_DIR" && fly deploy -a "$MINION_NAME" 2>&1 | tail -10)
  success "Deployed!"

  # --- Done ---
  echo -e "\n${BOLD}══════════════════════════════════════════${RESET}"
  echo -e "${GREEN}✓ Minion deployed successfully!${RESET}\n"
  echo -e "  App:       ${CYAN}$MINION_NAME${RESET}"
  echo -e "  Dashboard: ${CYAN}https://fly.io/apps/$MINION_NAME${RESET}"
  echo -e "  Repo:      ${CYAN}$TARGET_REPO${RESET}\n"

  echo -e "${YELLOW}Next steps:${RESET}"
  echo -e "  1. Auth Claude on the machine:"
  echo -e "     ${CYAN}fly ssh console -a $MINION_NAME${RESET}"
  echo -e "     ${CYAN}su - minion -c 'HOME=/workspace/home claude'${RESET}"
  echo -e "     Complete OAuth in browser, then type ${CYAN}/exit${RESET}\n"
  echo -e "  2. Send a task to your Telegram group:"
  echo -e "     ${CYAN}/task target add a README file${RESET}\n"
}

main "$@"
