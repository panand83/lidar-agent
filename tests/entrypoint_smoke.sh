#!/bin/sh
set -eu

root=$(mktemp -d)
mkdir -p "$root/seed" "$root/config"
mkdir -p "$root/seed/lidars"
printf 'project-initial' > "$root/seed/lidars.json"
printf 'agent-initial' > "$root/seed/lidars/137.json"

KLA_SEED_DIR="$root/seed" KLA_CONFIG_DIR="$root/config" sh docker-entrypoint.sh true
test "$(cat "$root/config/lidars.json")" = project-initial
test "$(cat "$root/config/lidars/137.json")" = agent-initial
test -f "$root/config/.project-seeded"

printf 'saved-in-ui' > "$root/config/lidars.json"
printf 'agent-saved-in-ui' > "$root/config/lidars/137.json"
printf 'project-changed' > "$root/seed/lidars.json"
printf 'agent-project-changed' > "$root/seed/lidars/137.json"
KLA_SEED_DIR="$root/seed" KLA_CONFIG_DIR="$root/config" sh docker-entrypoint.sh true
test "$(cat "$root/config/lidars.json")" = saved-in-ui
test "$(cat "$root/config/lidars/137.json")" = agent-saved-in-ui

mkdir -p "$root/old-config"
mkdir -p "$root/old-config/lidars"
printf 'previous-install' > "$root/old-config/lidars.json"
printf 'previous-agent' > "$root/old-config/lidars/137.json"
KLA_SEED_DIR="$root/seed" KLA_CONFIG_DIR="$root/old-config" sh docker-entrypoint.sh true
test "$(cat "$root/old-config/lidars.json")" = project-changed
test "$(cat "$root/old-config/lidars.json.before-project-seed")" = previous-install
test "$(cat "$root/old-config/lidars/137.json")" = agent-project-changed
test "$(cat "$root/old-config/lidars/137.json.before-project-seed")" = previous-agent

mkdir -p "$root/new-seed/lidars" "$root/new-config"
printf 'agent-only' > "$root/new-seed/lidars/138.json"
KLA_SEED_DIR="$root/new-seed" KLA_CONFIG_DIR="$root/new-config" sh docker-entrypoint.sh true
test "$(cat "$root/new-config/lidars/138.json")" = agent-only

printf 'entrypoint seed and restart checks passed\n'
