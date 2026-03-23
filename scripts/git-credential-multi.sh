#!/bin/bash
declare -A TOKENS
IFS="," read -ra PAIRS <<< "$GITHUB_TOKENS"
for pair in "${PAIRS[@]}"; do
  org="${pair%%:*}"
  token="${pair#*:}"
  TOKENS["$org"]="$token"
done

host="" path=""
while IFS="=" read -r key value; do
  [ -z "$key" ] && break
  [ "$key" = "host" ] && host="$value"
  [ "$key" = "path" ] && path="$value"
done

[ "$host" != "github.com" ] && exit 0

org="${path%%/*}"
if [ -n "${TOKENS[$org]}" ]; then
  echo "protocol=https"
  echo "host=github.com"
  echo "username=x-access-token"
  echo "password=${TOKENS[$org]}"
fi
