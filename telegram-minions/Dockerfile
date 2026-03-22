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

# Install Goose CLI (manual extract — the install script tries interactive configure)
RUN curl -fsSL -o /tmp/goose.tar.bz2 \
      https://github.com/block/goose/releases/download/stable/goose-x86_64-unknown-linux-gnu.tar.bz2 \
    && tar -xjf /tmp/goose.tar.bz2 -C /tmp \
    && mv /tmp/goose /usr/local/bin/goose \
    && chmod +x /usr/local/bin/goose \
    && rm /tmp/goose.tar.bz2

# Install Claude Code CLI (needed for claude auth login + claude-agent-acp)
RUN npm install -g @anthropic-ai/claude-code @zed-industries/claude-agent-acp

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

# Non-root user (claude-agent-acp SIGKILL's under root)
RUN useradd -m -s /bin/bash minion

RUN chmod +x /app/entrypoint.sh /app/scripts/*.sh

# Entrypoint runs as root to fix volume ownership, then drops to minion user.
# After first deploy:
#   fly ssh console
#   su - minion -c 'HOME=/workspace/home claude auth login'
CMD ["/app/entrypoint.sh"]
