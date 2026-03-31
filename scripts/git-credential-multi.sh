#!/bin/bash
host="" path=""
while IFS="=" read -r key value; do
  [ -z "$key" ] && break
  [ "$key" = "host" ] && host="$value"
  [ "$key" = "path" ] && path="$value"
done

[ "$host" != "github.com" ] && exit 0

org="${path%%/*}"

# Prefer GITHUB_TOKEN (refreshed by GitHub App auth) over static GITHUB_TOKENS
token="$GITHUB_TOKEN"

if [ -z "$token" ] && [ -n "$GITHUB_TOKENS" ]; then
  declare -A TOKENS
  IFS="," read -ra PAIRS <<< "$GITHUB_TOKENS"
  for pair in "${PAIRS[@]}"; do
    k="${pair%%:*}"
    v="${pair#*:}"
    TOKENS["$k"]="$v"
  done
  token="${TOKENS[$org]}"
fi

if [ -n "$token" ]; then
  echo "protocol=https"
  echo "host=github.com"
  echo "username=x-access-token"
  echo "password=$token"
fi
