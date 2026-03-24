#!/bin/bash
mkdir -p /workspace/home/.claude
chown -R minion:minion /workspace

# Copy agent definitions from the npm package (updated on version bump)
PKG_AGENTS=/app/node_modules/@tprei/telegram-minions/assets/agents
if [ -d "$PKG_AGENTS" ]; then
  mkdir -p /workspace/home/.claude/agents
  cp "$PKG_AGENTS"/*.md /workspace/home/.claude/agents/
fi

# Overlay any client-specific agent overrides
if [ -d /app/.claude/agents ]; then
  cp /app/.claude/agents/*.md /workspace/home/.claude/agents/ 2>/dev/null
fi
if [ -f /app/.claude/settings.json ]; then
  cp /app/.claude/settings.json /workspace/home/.claude/
fi
if [ -f /app/.claude/CLAUDE.md ]; then
  cp /app/.claude/CLAUDE.md /workspace/home/.claude/
fi

su -s /bin/bash -p minion -c '/app/scripts/setup-git.sh'
exec su -s /bin/bash -p minion -c "node /app/dist/index.js"
