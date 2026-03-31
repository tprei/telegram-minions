FROM ghcr.io/astral-sh/uv:latest AS uv

FROM node:22-slim

# Install system dependencies + GitHub CLI
RUN apt-get update && apt-get install -y \
  git curl ca-certificates bzip2 libgomp1 \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && apt-get update && apt-get install -y gh \
  && rm -rf /var/lib/apt/lists/*

# Install UV package manager (from official image)
COPY --from=uv /uv /uvx /usr/local/bin/

# Install managed Python 3.13 via UV
ENV UV_PYTHON_INSTALL_DIR="/opt/uv-python"
RUN uv python install 3.13 \
    && chmod -R o+rx /opt/uv-python

# Install build-essential for Python packages with C extensions
RUN apt-get update && apt-get install -y build-essential \
    && rm -rf /var/lib/apt/lists/*

# Pre-install Node.js devtools as ancestor-resolution fallback
RUN mkdir -p /opt/devtools \
    && cd /opt/devtools \
    && npm init -y \
    && npm install --ignore-scripts vitest typescript happy-dom jsdom \
    && rm package.json package-lock.json \
    && node -e "const c=require('crypto');const h=c.createHash('sha256');const fs=require('fs');h.update(fs.readdirSync('/opt/devtools/node_modules').sort().join(','));fs.writeFileSync('/opt/devtools/.version',h.digest('hex'))" \
    && chmod -R o+rx /opt/devtools

# Pre-install Python devtools as global fallback
ENV UV_TOOL_DIR="/opt/uv-tools"
ENV UV_TOOL_BIN_DIR="/opt/uv-tools/bin"
RUN uv tool install pytest \
    && uv tool install ruff \
    && uv tool install mypy \
    && chmod -R o+rx /opt/uv-tools

# Install Goose CLI (manual extract — the install script tries interactive configure)
RUN curl -fsSL -o /tmp/goose.tar.bz2 \
      https://github.com/block/goose/releases/download/stable/goose-x86_64-unknown-linux-gnu.tar.bz2 \
    && tar -xjf /tmp/goose.tar.bz2 -C /tmp \
    && mv /tmp/goose /usr/local/bin/goose \
    && chmod +x /usr/local/bin/goose \
    && rm /tmp/goose.tar.bz2

# Install Claude Code CLI + MCP servers
RUN npm install -g \
  @anthropic-ai/claude-code \
  @zed-industries/claude-agent-acp \
  @playwright/mcp \
  @upstash/context7-mcp

# Install GitHub MCP server (official Go binary)
RUN curl -fsSL -o /tmp/github-mcp-server.tar.gz \
      https://github.com/github/github-mcp-server/releases/latest/download/github-mcp-server_Linux_x86_64.tar.gz \
    && tar -xzf /tmp/github-mcp-server.tar.gz -C /tmp \
    && mv /tmp/github-mcp-server /usr/local/bin/github-mcp-server \
    && chmod +x /usr/local/bin/github-mcp-server \
    && rm /tmp/github-mcp-server.tar.gz

# Install Playwright browsers to a shared path accessible by non-root users
ENV PLAYWRIGHT_BROWSERS_PATH="/opt/pw-browsers"
RUN chmod 1777 /tmp && apt-get update && npx playwright install --with-deps chromium && chmod -R o+rx /opt/pw-browsers && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json .npmrc* ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --production

# Non-root user (claude-agent-acp SIGKILL's under root)
RUN useradd -m -s /bin/bash minion \
    && chown -R minion:minion /opt/pw-browsers \
    && chown -R minion:minion /opt/uv-python \
    && chown -R minion:minion /opt/devtools \
    && chown -R minion:minion /opt/uv-tools

RUN chmod +x /app/entrypoint.sh /app/scripts/*.sh

# Entrypoint runs as root to fix volume ownership, then drops to minion user.
# After first deploy:
#   fly ssh console
#   su -s /bin/bash -p minion -c 'claude auth login'
CMD ["/app/entrypoint.sh"]
