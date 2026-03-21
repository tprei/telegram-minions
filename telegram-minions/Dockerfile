FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  ca-certificates \
  bzip2 \
  && rm -rf /var/lib/apt/lists/*

# Install Goose CLI
RUN curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash

# Install claude-agent-acp (ACP provider for Goose → Claude Code subscription)
RUN npm install -g @zed-industries/claude-agent-acp

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

# HOME is set to /workspace/home at runtime (fly.toml env) so claude auth persists on the volume.
# On first deploy: fly ssh console → claude auth login → follow the URL → done.
CMD ["node", "dist/main.js"]
