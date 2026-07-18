#!/usr/bin/env bash
# Station rehearsal: runs the terminal demo (job create -> response create ->
# job show -> finalize) against the scripted rehearsal server, so it can be
# rehearsed without a live OPENAI_API_KEY. This is a fallback path for
# practicing the shared-screen narration; the real pitch should use a live
# key run (server/index.ts via `OPENAI_API_KEY=... npm start`) whenever one
# is available.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${PORT:-8790}"
API="http://127.0.0.1:${PORT}"
GOVERNOR="npx tsx cli/token-governor.ts --api ${API}"

banner() {
  echo
  echo "=== $1 ==="
}

echo "Starting the rehearsal API on ${API} (scripted provider, no API key needed)..."
PORT="$PORT" npx tsx station/rehearsal-server.ts &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -s -o /dev/null "${API}/api/health"; then
    break
  fi
  sleep 0.2
done

banner "Create a governed job with a \$0.075 budget"
JOB_JSON=$($GOVERNOR job create --budget 0.075 --json)
echo "$JOB_JSON" | node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync(0,'utf8')), null, 2))"
JOB_ID=$(echo "$JOB_JSON" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")
echo
echo "Job: ${JOB_ID}"

banner "Submit the work step through the governor"
$GOVERNOR response create --job "$JOB_ID" --request work:1 --phase work \
  --input "Read the PR diff and the failing test log, then investigate."

banner "Submit the final answer through the governor"
$GOVERNOR response create --job "$JOB_ID" --request final:1 --phase final \
  --input "Return the structured review."

banner "Accept the final answer"
$GOVERNOR job finalize --job "$JOB_ID" --request final:1 --accept

banner "Receipt"
$GOVERNOR job show "$JOB_ID"
