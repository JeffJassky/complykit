#!/usr/bin/env bash
# Deploy complykit (plans/do-hosting.md): the worker image to Fly first, then
# the host to DigitalOcean App Platform with WORKER_IMAGE pointing at it. A new
# host must never call workers running an older protocol, hence the order.
#
#   scripts/deploy-do.sh            # build + push the worker image, then deploy the host
#
# First run (no `complykit` app yet) creates the app from .do/app.yaml and needs
# these in the environment: MONGO_URL MONGO_CA SPACES_KEY SPACES_SECRET
# FLY_API_TOKEN WORKER_SECRET. Later runs keep the stored (encrypted) secrets
# and change only WORKER_IMAGE.
#
# Needs: flyctl (~/.fly/bin/fly or on PATH), doctl with an `amplify-11` context, python3.
set -euo pipefail
cd "$(dirname "$0")/.."

FLY=${FLY:-$(command -v fly || echo ~/.fly/bin/fly)}
DO_CONTEXT=${DO_CONTEXT:-amplify-11}
WORKERS_APP=${WORKERS_APP:-complykit-workers}
APP_NAME=complykit

if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to deploy a dirty tree (commit first: App Platform builds from GitHub main)" >&2
  exit 1
fi
SHA=$(git rev-parse --short HEAD)
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main 2>/dev/null || true)" ]; then
  echo "HEAD is not origin/main: push main first (App Platform builds from GitHub main)" >&2
  exit 1
fi

echo "==> worker image ($SHA) to registry.fly.io/$WORKERS_APP"
"$FLY" deploy -a "$WORKERS_APP" --build-only --push --image-label "$SHA" --remote-only
WORKER_IMAGE="registry.fly.io/$WORKERS_APP:$SHA"

APP_ID=$(doctl --context "$DO_CONTEXT" apps list -o json | python3 -c "import json,sys; print(next((a['id'] for a in json.load(sys.stdin) if a['spec']['name']=='$APP_NAME'), ''))")

SPEC=$(mktemp)
trap 'rm -f "$SPEC"' EXIT
if [ -z "$APP_ID" ]; then
  echo "==> creating App Platform app $APP_NAME"
  for v in MONGO_URL MONGO_CA SPACES_KEY SPACES_SECRET FLY_API_TOKEN WORKER_SECRET; do
    [ -n "${!v:-}" ] || { echo "missing $v in the environment (needed to create the app)" >&2; exit 1; }
  done
  export WORKER_IMAGE
  # Values go in as JSON strings (valid YAML), so a multi-line CA survives.
  python3 - .do/app.yaml > "$SPEC" <<'PY'
import json, os, re, sys
text = open(sys.argv[1]).read()
print(re.sub(r'"\$\{([A-Z_]+)\}"', lambda m: json.dumps(os.environ[m.group(1)]), text))
PY
  doctl --context "$DO_CONTEXT" apps create --spec "$SPEC" --wait
else
  echo "==> updating $APP_NAME ($APP_ID): WORKER_IMAGE=$WORKER_IMAGE"
  doctl --context "$DO_CONTEXT" apps spec get "$APP_ID" -o json > "$SPEC"
  python3 - "$SPEC" "$WORKER_IMAGE" <<'PY'
import json, sys
path, image = sys.argv[1], sys.argv[2]
spec = json.load(open(path))
for svc in spec.get('services', []):
    for e in svc.get('envs', []):
        if e['key'] == 'WORKER_IMAGE':
            e['value'] = image
json.dump(spec, open(path, 'w'))
PY
  doctl --context "$DO_CONTEXT" apps update "$APP_ID" --spec "$SPEC" --wait
  doctl --context "$DO_CONTEXT" apps create-deployment "$APP_ID" --wait
fi

URL=$(doctl --context "$DO_CONTEXT" apps list -o json | python3 -c "import json,sys; print(next((a.get('live_url','') for a in json.load(sys.stdin) if a['spec']['name']=='$APP_NAME'), ''))")
echo "==> live at $URL"
curl -fsS "$URL/api/health" && echo
