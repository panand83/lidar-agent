#!/usr/bin/env bash
set -euo pipefail

if (( EUID != 0 )); then
  echo "Run with sudo: sudo bash deploy-ubuntu.sh" >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")"

env_dir=/usr/src/env/kyra-lidar-agent
env_file=$env_dir/.env.kla.qa
config_dir=/usr/src/lidar-config
log_dir=/var/log/iclogs/kyra-lidar-agent

install -d -m 700 "$env_dir" "$config_dir" "$log_dir"

if [[ ! -f "$env_file" ]]; then
  if [[ -f /usr/src/env/.env.kla.qa ]]; then
    install -m 600 /usr/src/env/.env.kla.qa "$env_file"
    echo "Migrated existing environment file to $env_file"
  else
    install -m 600 env.kla.qa.example "$env_file"
    echo "Created $env_file from the example; set MQTT values there or in the LiDAR UI."
  fi
fi

for name in lidars.json integrations-cache.json; do
  if [[ ! -e "$config_dir/$name" && -f "data/$name" ]]; then
    install -m 600 "data/$name" "$config_dir/$name"
    echo "Imported existing $name"
  fi
done

if [[ -d data/lidars ]]; then
  install -d -m 700 "$config_dir/lidars"
  for source in data/lidars/*.json; do
    [[ -f "$source" ]] || continue
    target="$config_dir/lidars/${source##*/}"
    if [[ ! -e "$target" ]]; then
      install -m 600 "$source" "$target"
      echo "Imported existing ${source##*/}"
    fi
  done
fi

KLA_ENV_FILE="$env_file" KLA_CONFIG_HOST_DIR="$config_dir" KLA_LOG_HOST_DIR="$log_dir" docker compose up -d --build
KLA_ENV_FILE="$env_file" KLA_CONFIG_HOST_DIR="$config_dir" KLA_LOG_HOST_DIR="$log_dir" docker compose ps
