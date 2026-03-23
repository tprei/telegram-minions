#!/bin/bash
git config --global user.name "telegram-minion"
git config --global user.email "minion@noreply"
git config --global credential.helper "/app/scripts/git-credential-multi.sh"
git config --global credential.useHttpPath true
