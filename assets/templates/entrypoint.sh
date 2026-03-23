#!/bin/bash
mkdir -p /workspace/home/.claude
chown -R minion:minion /workspace

# Copy custom agent definitions if provided (falls back to package defaults)
if [ -d /app/agents ]; then
  cp -r /app/agents /workspace/home/.claude/
fi
if [ -d /app/.claude/agents ]; then
  cp -r /app/.claude/agents /workspace/home/.claude/
fi
if [ -f /app/.claude/settings.json ]; then
  cp /app/.claude/settings.json /workspace/home/.claude/
fi
if [ -f /app/.claude/CLAUDE.md ]; then
  cp /app/.claude/CLAUDE.md /workspace/home/.claude/
fi

su -s /bin/bash -p minion -c '/app/scripts/setup-git.sh'
exec su -s /bin/bash -p minion -c "node /app/dist/index.js"
