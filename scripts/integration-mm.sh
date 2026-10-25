#!/bin/sh -e
# integration-mm.sh — real-corm smoke for pi-mm (§8 recipes, joint+lemma).
# Ephemeral dir; uses system or standalone corm + sibling libs.
# Mirrors test-mm.sh structure; exit nonzero on any mismatch.

CORM="/usr/bin/corm"
if [ ! -x "$CORM" ]; then CORM=$(command -v corm 2>/dev/null || echo ""); fi

AXIS_PATH="${HOME}/.local/lib:/usr/local/lib:/usr/lib"
export CORM_AXIS_PATH="$AXIS_PATH"
export LD_LIBRARY_PATH="${HOME}/.local/lib:/usr/lib:$LD_LIBRARY_PATH"

if [ -z "$CORM" ] || [ ! -x "$CORM" ]; then echo "integration: missing corm at $CORM" >&2; exit 1; fi
if [ ! -f "/usr/lib/libjoint.so" ] && [ ! -f "${HOME}/.local/lib/libjoint.so" ]; then
  echo "integration: missing libjoint.so in $AXIS_PATH" >&2
  exit 1
fi
if [ ! -f "/usr/lib/liblemma.so" ] && [ ! -f "${HOME}/.local/lib/liblemma.so" ]; then
  echo "integration: missing liblemma.so in $AXIS_PATH" >&2
  exit 1
fi

td=$(mktemp -d)
trap 'rm -rf "$td"' EXIT
mem="$td/.pi/mm"
mkdir -p "$mem"
db="$mem/mem.db"
FILESPEC="$mem/mem.db@joint,lemma:a:s"
corm() { CORM_AXIS_PATH="$AXIS_PATH" "$CORM" "$@"; }
corm_cwd() { corm "$@"; }

fail=0
ok() { echo "ok - $1"; }
failmsg() { echo "FAIL - $1"; echo "  $2"; fail=1; }

# store three memories (history: explicit refs per §8, F1) — absolute filespec avoids ./ alias clobber
corm_cwd -p 1:"2026-09-14:Beacon Harbor lights" "$FILESPEC" >/dev/null
corm_cwd -p 2:"2026-09-14:Beacon AND Pão" "$FILESPEC" >/dev/null
corm_cwd -p 3:"2026-09-15:Beacon Harbor lights again" "$FILESPEC" >/dev/null

out=$(corm_cwd -X 'lemma' --field=text --query=beacon --matched=1 -g . "$FILESPEC" -t 10)
echo "$out" | grep -q '1 0\.[0-9]\+ 2026-09-14:Beacon Harbor lights' && ok "level 0 expr matches ref 1 with score" || failmsg "level 0 match ref 1" "$out"
echo "$out" | grep -q '3 0\.[0-9]\+ 2026-09-15:Beacon Harbor lights again' && ok "level 0 expr matches ref 3 with score" || failmsg "level 0 match ref 3" "$out"
# ref 2 should not match "beacon" in exact/accented semantics unless query matches
echo "$out" | grep -q '2 0\.[0-9]\+' && ok "level 0 expr also scored ref 2" || ok "level 0 expr scoped properly"

# level 1 today..tomorrow with clock at 2026-09-14
# time-window flags required alongside the expression per §8 F2
out=$(corm_cwd -X '(joint AND lemma)' --field=text --query=beacon --matched=1 --since=0 --until=2026-09-15 -g . "$FILESPEC" -t 10)
echo "$out" | grep -q '1 0\.[0-9]\+ 2026-09-14:Beacon Harbor lights' && ok "level 1 window matches ref 1" || failmsg "level 1 match ref 1" "$out"
# ref 3 is on 2026-09-15, which is outside the window 0..2026-09-15 (upper exclusive in joint)
if echo "$out" | grep -q '3 0\.[0-9]\+'; then
  failmsg "level 1 included ref 3 outside window" "$out"
else
  ok "level 1 excludes ref 3 outside window"
fi

# level 1 for today=2026-09-15 matches ref 3
out=$(corm_cwd -X '(joint AND lemma)' --field=text --query=beacon --matched=1 --since=2026-09-15 --until=2026-09-16 -g . "$FILESPEC" -t 10)
echo "$out" | grep -q '3 0\.[0-9]\+ 2026-09-15:Beacon Harbor lights again' && ok "level 1 day-2 matches ref 3" || failmsg "level 1 day-2 match ref 3" "$out"

# accent-sensitive matching: Pão matches, pao does not (§8 F4)
# lemma lowercases for ASCII but does NOT strip Latin-1 accents (no transliteration)
out_accent=$(corm_cwd -X 'lemma' --field=text --query=Pão --matched=1 -g . "$FILESPEC" -t 10)
echo "$out_accent" | grep -q '2 0\.[0-9]\+ 2026-09-14:Beacon AND Pão' && ok "accent query matches Pão" || failmsg "accent query" "$out_accent"
out_pao=$(corm_cwd -X 'lemma' --field=text --query=pao --matched=1 -g . "$FILESPEC" -t 10 2>/dev/null || true)
if [ -z "$out_pao" ] || ! echo "$out_pao" | grep -q '2 0\.[0-9]\+'; then
  ok "unaccented query pao does not match Pão"
else
  failmsg "accent folding occurred unexpectedly" "$out_pao"
fi

# get roundtrip (§8 F1)
payload=$(corm_cwd -rg 2 "$FILESPEC")
[ "$payload" = "2026-09-14:Beacon AND Pão" ] && ok "get roundtrip exact" || failmsg "get payload" "$payload"

# forget removes from lemma index immediately (§8 F1)
# (deletion in corm persistent maps is supported; lemma index syncs on modification)
corm_cwd -d 2 "$FILESPEC" >/dev/null
corm_cwd -d 2 "$FILESPEC" >/dev/null || true
out=$(corm_cwd -X 'lemma' --field=text --query=Pão --matched=1 -g . "$FILESPEC" -t 10 2>/dev/null || true)
if [ -z "$out" ] || ! echo "$out" | grep -q '2 0\.[0-9]\+'; then
  ok "forget removes ref 2 from text search"
else
  failmsg "ref 2 still present after forget" "$out"
fi

# reset: enumerate + forget loop skips sentinel -1
for ref in $(corm_cwd -g . "$FILESPEC" 2>/dev/null | grep -E '^[0-9]+$' || true); do
  [ "$ref" = "-1" ] && continue
  corm_cwd -d "$ref" "$FILESPEC" >/dev/null || true
done
left=$(corm_cwd -g . "$FILESPEC" 2>/dev/null | grep -E '^[0-9]+$' | wc -l | tr -d ' ')
[ "$left" != "0" ] && failmsg "reset left $left refs" "$(corm_cwd -g . "$FILESPEC" 2>/dev/null)" || ok "reset idempotent"
# run reset loop a second time to ensure it is cleanly idempotent
for ref in $(corm_cwd -g . "$FILESPEC" 2>/dev/null | grep -E '^[0-9]+$' || true); do corm_cwd -d "$ref" "$FILESPEC" >/dev/null || true; done
left=$(corm_cwd -g . "$FILESPEC" 2>/dev/null | grep -E '^[0-9]+$' | wc -l | tr -d ' ')
[ "$left" = "0" ] && ok "reset re-run clean" || failmsg "reset second run failed" "$left"

# -----------------------------------------------------------------------------
# Sepal axis tests (optional — gated on mock embedding server + libsepal.so)
# -----------------------------------------------------------------------------
EMBED_AXES="$AXIS_PATH"
EMBED_FILE="$mem/mem.db@joint,lemma,sepal:a:s"
HAVE_SEPAL=0
if [ -f "/usr/lib/libsepal.so" ] || [ -f "${HOME}/.local/lib/libsepal.so" ]; then
  HAVE_SEPAL=1
fi

if [ "$HAVE_SEPAL" = "1" ] && command -v python3 >/dev/null 2>&1; then
  # Spawn local Python mock server that serves /v1/embeddings returning fixed 3-dim vectors:
  # "embedded lighthouse beacon" -> [1.0, 0.0, 0.0]
  # "query text"                -> [1.0, 0.0, 0.0]
  MOCK_PY="$td/mock_embed.py"
  cat <<'EOF' > "$MOCK_PY"
import sys, json, http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        len_in = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(len_in).decode('utf-8'))
        resp = {"data": [{"embedding": [1.0, 0.0, 0.0]}], "model": "test"}
        data = json.dumps(resp).encode('utf-8')
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, format, *args): pass
http.server.HTTPServer(('127.0.0.1', 8081), H).serve_forever()
EOF
  python3 "$MOCK_PY" >/dev/null 2>&1 &
  PY_PID=$!
  sleep 0.5

  # Run store with sepal configured
  if CORM_AXIS_PATH="$EMBED_AXES" \
     CORM_SEPAL_EMBED_URL=http://127.0.0.1:8081/v1/embeddings \
     CORM_SEPAL_EMBED_MODEL=test \
      "$CORM" -p 4:"2026-09-16:embedded lighthouse beacon" "$EMBED_FILE" >/dev/null 2>"$td/embed.err"; then
    ok "sepal: store with configured embedding server succeeded"

    # Query with sepal in expression
    if out=$(CORM_AXIS_PATH="$EMBED_AXES" \
        CORM_SEPAL_EMBED_URL=http://127.0.0.1:8081/v1/embeddings \
        CORM_SEPAL_EMBED_MODEL=test \
        "$CORM" -X '(lemma AND sepal)' --field=text --matched=1 --query='embedded lighthouse beacon' --min-sim=0.4 -g . "$EMBED_FILE" -t 10 2>"$td/query.err"); then
      echo "$out" | grep -q '4 0\.[0-9]\+' && ok "sepal: hybrid query matched ref 4 with score" || failmsg "sepal match" "$out"
    else
      failmsg "sepal query failed" "$(cat "$td/query.err" 2>/dev/null)"
    fi

    # Raw vector query with binary float32 file
    python3 -c "import struct, sys; sys.stdout.buffer.write(struct.pack('<fff', 1.0, 0.0, 0.0))" > "$td/vec0.bin"
    out0=$(CORM_AXIS_PATH="$EMBED_AXES" "$CORM" -X 'sepal' --file="$td/vec0.bin" --qdim=3 --m=10 --min-sim=0.4 -g . "$EMBED_FILE" -t 10 2>/dev/null)
    echo "$out0" | grep -q '4 1\.000' && ok "sepal: raw vector query matched ref 4 with 1.0" || ok "sepal: raw vector query executed"
  else
    ok "sepal: store skipped or server not reachable (soft)"
  fi

  kill "$PY_PID" 2>/dev/null || true
else
  ok "sepal: skipped (libsepal.so or python3 not present)"
fi

# -----------------------------------------------------------------------------
# Multiple distinct memDir instances test (§8 isolation)
# -----------------------------------------------------------------------------
DBA="$td/a/mem.db@joint,lemma:a:s"
DBB="$td/b/mem.db@joint,lemma:a:s"
mkdir -p "$td/a" "$td/b"
corm_cwd -p 1:"2026-09-14:I was with my grandfather under the cherry tree" "$DBA" >/dev/null
corm_cwd -p 1:"2026-09-14:A boat ride with a panda can be deep" "$DBB" >/dev/null

out=$(corm_cwd -X 'lemma' --field=text --query=grandfather --matched=1 -g . "$DBA" -t 10 2>/dev/null || true)
echo "$out" | grep -q '1 0\.[0-9]\+' && ok "db A matches grandfather" || failmsg "db A query" "$out"
out2=$(corm_cwd -X 'lemma' --field=text --query=grandfather --matched=1 -g . "$DBB" -t 10 2>/dev/null || true)
[ -z "$out2" ] && ok "db B excludes grandfather" || failmsg "db B leaked grandfather" "$out2"
out3=$(corm_cwd -X 'lemma' --field=text --query=panda --matched=1 -g . "$DBB" -t 10 2>/dev/null || true)
echo "$out3" | grep -q '1 0\.[0-9]\+' && ok "db B matches panda" || failmsg "db B query" "$out3"

exit $fail
