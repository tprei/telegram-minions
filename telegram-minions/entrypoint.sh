#!/bin/bash
mkdir -p /workspace/home/.claude
chown -R minion:minion /workspace

cp -r /app/.claude/agents /workspace/home/.claude/
cp /app/.claude/settings.json /workspace/home/.claude/

su -s /bin/bash -p minion -c '/app/scripts/setup-git.sh'
exec su -s /bin/bash -p minion -c "node /app/dist/main.js"
