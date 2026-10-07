#!/bin/sh
set -eu

umask 077
seed_dir=${KLA_SEED_DIR:-/opt/kyra-lidar-agent/seed-data}
config_dir=${KLA_CONFIG_DIR:-/usr/src/lidar-config}

mkdir -p "$config_dir"
if [ ! -e "$config_dir/.project-seeded" ]; then
  for name in lidars.json integrations-cache.json; do
    if [ -f "$seed_dir/$name" ]; then
      if [ -f "$config_dir/$name" ] && [ ! -e "$config_dir/$name.before-project-seed" ]; then
        cp "$config_dir/$name" "$config_dir/$name.before-project-seed"
      fi
      cp "$seed_dir/$name" "$config_dir/$name"
      echo "Initialized $config_dir/$name from project data"
    fi
  done
  if [ -d "$seed_dir/lidars" ]; then
    mkdir -p "$config_dir/lidars"
    for source in "$seed_dir"/lidars/*.json; do
      [ -f "$source" ] || continue
      name=${source##*/}
      target="$config_dir/lidars/$name"
      if [ -f "$target" ] && [ ! -e "$target.before-project-seed" ]; then
        cp "$target" "$target.before-project-seed"
      fi
      cp "$source" "$target"
      echo "Initialized $target from project data"
    done
  fi
  touch "$config_dir/.project-seeded"
fi

exec "$@"
