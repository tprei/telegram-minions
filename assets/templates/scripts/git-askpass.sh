#!/bin/bash
case "$1" in
  Username*) echo "x-access-token" ;;
  Password*) echo "${GITHUB_TOKEN}" ;;
esac
