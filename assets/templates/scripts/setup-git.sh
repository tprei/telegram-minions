#!/bin/bash
git config --global user.name "telegram-minion"
git config --global user.email "minion@noreply"

if [ -n "$GITHUB_TOKEN" ]; then
  git config --global credential.helper store
  echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
fi
