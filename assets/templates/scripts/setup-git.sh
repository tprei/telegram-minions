#!/bin/bash
git config --global user.name "telegram-minion"
git config --global user.email "minion@noreply"

if [ -n "$GITHUB_TOKENS" ]; then
  # Multi-org: GITHUB_TOKENS="org1:token1,org2:token2"
  git config --global credential.helper "/app/scripts/git-credential-multi.sh"
  git config --global credential.useHttpPath true
elif [ -n "$GITHUB_TOKEN" ]; then
  # Single token fallback
  git config --global credential.helper store
  echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > "$HOME/.git-credentials"
fi
