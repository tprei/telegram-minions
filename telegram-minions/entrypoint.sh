#!/bin/bash
mkdir -p /workspace/home
chown -R minion:minion /workspace
su -s /bin/bash -p minion -c '/app/scripts/setup-git.sh'
exec su -s /bin/bash -p minion -c "node /app/dist/main.js"
