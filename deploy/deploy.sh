#!/bin/bash
# Copies the project to the server and (re)builds and starts it.
# Run after `terraform apply`. Uses SSH_KEY if set, otherwise your default SSH key.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HOST:-$(terraform -chdir="$ROOT/deploy/terraform" output -raw public_ip)}"
SSH=(ssh -o StrictHostKeyChecking=accept-new ${SSH_KEY:+-i "$SSH_KEY"})

# The container refuses to start without a UI password, so check before copying.
if ! grep -Eq '^UI_PASSWORD=.+' "$ROOT/.env" 2>/dev/null; then
  echo "Set UI_PASSWORD in $ROOT/.env first (the UI is public on the server)." >&2
  exit 1
fi

echo "==> Waiting for $HOST to accept SSH and finish first-boot setup"
for _ in $(seq 1 30); do
  "${SSH[@]}" -o ConnectTimeout=5 "ec2-user@$HOST" true 2>/dev/null && break
  sleep 5
done
"${SSH[@]}" "ec2-user@$HOST" 'cloud-init status --wait >/dev/null || true'

echo "==> Copying code"
# The local data/ (your dev database) stays local; the server keeps its own in a
# Docker volume. deploy/.env on the server is written at boot and kept.
rsync -az --delete -e "${SSH[*]}" \
  --exclude .git --exclude node_modules --exclude /data/ \
  --exclude deploy/terraform --exclude deploy/.env \
  "$ROOT/" "ec2-user@$HOST:/opt/voicebot/"

echo "==> Building and starting"
"${SSH[@]}" "ec2-user@$HOST" 'cd /opt/voicebot/deploy && docker compose up -d --build --remove-orphans && docker image prune -f >/dev/null && docker compose ps'

echo "==> Done. Logs: ${SSH[*]} ec2-user@$HOST 'cd /opt/voicebot/deploy && docker compose logs -f'"
