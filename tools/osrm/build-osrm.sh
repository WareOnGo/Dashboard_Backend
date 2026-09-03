#!/bin/bash
# Build an OSRM routing graph for India and serve it on :5000.
#
# THIS IS THE THIRD ATTEMPT. The first two were OOM-killed by the kernel in
# osrm-extract, both at the same phase, and both times all we learned was that
# the process had died. So this script differs from those in three ways:
#
#   1. It FILTERS THE EXTRACT FIRST. osrm-extract's peak memory is dominated by
#      the node-location cache, which must hold coordinates for every node any
#      way references. India's full extract carries buildings, landuse and
#      coastline that routing never looks at. Keeping only highway ways and the
#      nodes they reference cuts the file to roughly a third and the node cache
#      with it. The Lua profile cannot do this: it runs after the cache is built.
#
#   2. It SAMPLES AVAILABLE MEMORY every 5s per phase and reports the low-water
#      mark. "Died at extract with 0.4GB free" is a fact you can act on; "died"
#      is not.
#
#   3. It CHECKS EXIT 137. A container killed by SIGKILL exits 137, which is how
#      the OOM killer shows up here — podman reports no error of its own, so the
#      first two attempts looked like generic failures.
#
# There is deliberately no `pgrep`/`pkill` anywhere. Three separate bugs earlier
# in this work came from a pattern matching the very shell that ran it.
set -u

# Where extracts and graph artefacts live. Deliberately NOT inside the repo: a
# single zone's artefacts are ~6GB and the national extract 1.6GB, and none of it
# belongs in git. Override with OSRM_WORKDIR.
WORKDIR=${OSRM_WORKDIR:-$HOME/osrm-data}
mkdir -p "$WORKDIR"
cd "$WORKDIR" || exit 1

IMG=ghcr.io/project-osrm/osrm-backend:latest
# Overridable so the same pipeline can be proved on a small regional extract
# before an hour is spent on the national one. osrm-extract names its output
# after its input, so BASE has to follow RAW.
RAW=${RAW:-india-latest.osm.pbf}
STEM=$(basename "$RAW" .osm.pbf)
PBF="${STEM}-roads.osm.pbf"      # what we actually feed to osrm-extract
BASE="${STEM}-roads"
THREADS=${THREADS:-4}
MIN_MB=${MIN_MB:-900}            # floor for "this download finished"

log () { echo "[$(date +%H:%M:%S)] $*"; }
avail_gb () { awk '/MemAvailable/{printf "%.1f", $2/1048576}' /proc/meminfo; }

# --- Sample memory during a phase, report the low-water mark -----------------
LOWFILE=$(mktemp)
watch_memory () {
    echo 999 > "$LOWFILE"
    while :; do
        a=$(avail_gb)
        low=$(cat "$LOWFILE")
        awk -v a="$a" -v l="$low" 'BEGIN{exit !(a<l)}' && echo "$a" > "$LOWFILE"
        sleep 5
    done
}

run_phase () {
    local name="$1"; shift
    log "=== $name (available: $(avail_gb)GB) ==="
    watch_memory & local watcher=$!
    local t0=$SECONDS
    podman run --rm -t -v "$PWD:/data:Z" "$IMG" "$@"
    local rc=$?
    kill "$watcher" 2>/dev/null
    wait "$watcher" 2>/dev/null
    local low; low=$(cat "$LOWFILE")
    log "    $name finished rc=$rc in $((SECONDS - t0))s, memory low-water ${low}GB"
    if [ "$rc" -eq 137 ]; then
        log "    KILLED BY SIGKILL — this is the OOM killer. Peak demand exceeded"
        log "    what was free. Close memory-heavy apps, or lower THREADS."
        return 137
    fi
    [ "$rc" -ne 0 ] && { log "    $name FAILED"; return "$rc"; }
    return 0
}

# --- 0. Verify the input is really a pbf -------------------------------------
SIZE=$(stat -c%s "$RAW" 2>/dev/null || echo 0)
log "raw extract: $(( SIZE / 1024 / 1024 )) MB"
if [ "$SIZE" -lt $(( MIN_MB * 1024 * 1024 )) ]; then
    log "TOO SMALL — refusing to build a partial graph."
    log "A proxy 502 already produced a 3KB HTML file that passed for a download once."
    exit 1
fi
# A pbf opens with a 4-byte big-endian header length then "\n\x07OSMHeader".
if ! head -c 16 "$RAW" | grep -qa OSMHeader; then
    log "NOT A PBF — no OSMHeader in the first 16 bytes. Probably an error page."
    exit 1
fi
# If the publisher shipped a checksum, that settles it before anything else runs.
# Worth the two minutes: a 1023MB download of the national extract passed both the
# size floor and the header check, and was corrupt — curl had exited 0. The md5 is
# the only check that catches a bad byte in the middle rather than a short file.
if [ -f "$RAW.md5" ]; then
    log "verifying checksum..."
    if md5sum -c "$RAW.md5" >/dev/null 2>&1; then
        log "    checksum OK"
    else
        log "CHECKSUM MISMATCH — the extract is corrupt or a different vintage."
        log "Re-download it. Note geofabrik 302-redirects -latest to a dated file,"
        log "so curl needs -L or you save a 253-byte redirect page instead."
        exit 1
    fi
else
    log "no $RAW.md5 alongside — skipping checksum (mirrors other than geofabrik"
    log "    build their own extracts, so a geofabrik md5 will not match them)"
fi

# The header check above is NOT sufficient and this is not hypothetical: curl
# exited 0 on a 1023MB download that osmium then rejected with "unexpected EOF".
# A truncated pbf keeps a perfectly valid header, so size and magic bytes both
# pass. The only real test is reading to the end — which the filter below does
# anyway, so its stderr is checked for truncation rather than paying for a
# separate full pass over a gigabyte.

# --- 1. Filter to routable ways ---------------------------------------------
# w/highway  : every road, path and track — the profile decides what is drivable
# r/type=restriction : turn restrictions, without which the router invents
#                      illegal turns and every distance is quietly optimistic
if [ -f "$PBF" ] && [ "$(stat -c%s "$PBF")" -gt 100000000 ]; then
    log "filtered extract already present ($(( $(stat -c%s "$PBF") / 1024 / 1024 )) MB), skipping filter"
elif command -v osmium >/dev/null 2>&1; then
    log "=== osmium tags-filter (available: $(avail_gb)GB) ==="
    t0=$SECONDS
    ERR=$(mktemp)
    osmium tags-filter --progress -o "$PBF" --overwrite \
        "$RAW" w/highway r/type=restriction 2> >(tee "$ERR" >&2)
    if [ $? -ne 0 ]; then
        if grep -qi "unexpected EOF\|truncat" "$ERR"; then
            log "THE EXTRACT IS TRUNCATED — not a filter problem."
            log "Resume it:  curl -L -C - -o $RAW https://download.geofabrik.de/asia/$RAW"
        else
            log "FILTER FAILED:"; sed 's/^/      /' "$ERR" | tail -5
        fi
        rm -f "$ERR" "$PBF"; exit 1
    fi
    rm -f "$ERR"
    log "    filtered in $((SECONDS - t0))s: $(( SIZE / 1024 / 1024 ))MB -> $(( $(stat -c%s "$PBF") / 1024 / 1024 ))MB"
else
    log "osmium NOT INSTALLED — falling back to the full extract."
    log "This is what was OOM-killed twice. Install it with:"
    log "    sudo dnf install -y osmium-tool"
    PBF="$RAW"; BASE="$STEM"
fi

# --- 2. Build ---------------------------------------------------------------
AV=$(avail_gb)
log "memory available before extract: ${AV}GB (threads=$THREADS)"
awk -v a="$AV" 'BEGIN{exit !(a<8)}' && log "WARNING: under 8GB free. Close Firefox/VS Code first — this is what OOMs."

run_phase "osrm-extract"   osrm-extract   -t "$THREADS" -p /opt/car.lua "/data/$PBF" || exit 1
run_phase "osrm-partition" osrm-partition -t "$THREADS" "/data/$BASE.osrm"            || exit 1
run_phase "osrm-customize" osrm-customize -t "$THREADS" "/data/$BASE.osrm"            || exit 1
log "artefacts: $(du -sh "$BASE".osrm* 2>/dev/null | tail -1 | cut -f1) total, disk free $(df -h . | awk 'NR==2{print $4}')"

# --- 3. Serve --------------------------------------------------------------
podman rm -f osrm-india >/dev/null 2>&1
# --max-table-size lifts the 100-coordinate default on /table. That cap is the
# only reason a k-nearest shortlist would still be needed: raised, we can ask for
# every candidate in radius at once and take the true minimum instead of hoping
# the winner was in the top k. It is also what makes the highway metric possible
# — sampling the centreline's own nodes is hundreds of coordinates per warehouse.
podman run -d --name osrm-india -p 5000:5000 -v "$PWD:/data:Z" "$IMG" \
    osrm-routed --algorithm mld --max-table-size 3000 "/data/$BASE.osrm" >/dev/null || exit 1

log "waiting for osrm-routed to accept connections..."
for i in $(seq 1 40); do
    curl -sf "http://localhost:5000/route/v1/driving/77.5946,12.9716;77.7066,13.1986?overview=false" \
        >/dev/null 2>&1 && break
    sleep 2
done

# --- 4. Verify the graph actually routes, INSIDE ITS OWN EXTENT ---------------
#
# The previous check routed between two fixed Bengaluru coordinates. Against the
# northern-zone graph that returned {"code":"Ok", "distance":0} — both points
# snapped to the same edge of a graph that does not contain Bengaluru — and the
# script then printed "OSRM READY" regardless. A graph with no roads in it at all
# would have produced exactly the same output, and the zone runner greps for that
# string to decide whether the build worked.
#
# So the test point is now derived from the extract's own header bounding box, and
# a zero distance is a FAILURE rather than a pass.
BBOX=$(osmium fileinfo "$RAW" 2>/dev/null | grep -oE '\([0-9.-]+,[0-9.-]+,[0-9.-]+,[0-9.-]+\)' | head -1 | tr -d '()')
if [ -z "$BBOX" ]; then
    # `osmium merge` writes NO header bounding box, so a graph built from merged
    # targeted boxes lands here (see the "Recomputing a few warehouses" section of
    # tools/highway-entry/README.md). Refusing outright was correct — the script
    # must not claim a graph works when it cannot test it — but it made that whole
    # workflow unverifiable. -e computes the real box by reading the file; measured
    # at 0.65s for a 49MB extract.
    log "no bounding box in the header (osmium merge drops it); computing from the data"
    BBOX=$(osmium fileinfo -e "$RAW" 2>/dev/null \
        | grep -oE '\([0-9.-]+,[0-9.-]+,[0-9.-]+,[0-9.-]+\)' | head -1 | tr -d '()')
fi
if [ -z "$BBOX" ]; then
    log "cannot read a bounding box from $RAW — refusing to claim the graph works"
    exit 1
fi
CLON=$(echo "$BBOX" | awk -F, '{printf "%.5f", ($1+$3)/2}')
CLAT=$(echo "$BBOX" | awk -F, '{printf "%.5f", ($2+$4)/2}')
# A second point ~15km east; OSRM snaps both onto the network itself.
DLON=$(echo "$CLON" | awk '{printf "%.5f", $1+0.15}')

log "=== verifying: centre of this extract ($CLAT,$CLON) -> ~15km east ==="
RESP=$(curl -s --max-time 20 "http://localhost:5000/route/v1/driving/$CLON,$CLAT;$DLON,$CLAT?overview=false")
CODE=$(echo "$RESP" | jq -r '.code // "none"' 2>/dev/null)
DIST=$(echo "$RESP" | jq -r '.routes[0].distance // 0' 2>/dev/null)
log "    code=$CODE distance=${DIST}m"

# A bbox centre can legitimately fall in sea or desert with no road for 15km, so a
# failure here is retried once against the densest thing we can name cheaply: the
# nearest routable point to that centre, per OSRM itself.
if [ "$CODE" != "Ok" ] || [ "${DIST%.*}" -eq 0 ] 2>/dev/null; then
    log "    centre unroutable; retrying from the nearest routable point to it"
    SNAP=$(curl -s --max-time 20 "http://localhost:5000/nearest/v1/driving/$CLON,$CLAT?number=1")
    SNAP_M=$(echo "$SNAP" | jq -r '.waypoints[0].distance // empty' 2>/dev/null | cut -d. -f1)
    SLON=$(echo "$SNAP" | jq -r '.waypoints[0].location[0] // empty' 2>/dev/null)
    SLAT=$(echo "$SNAP" | jq -r '.waypoints[0].location[1] // empty' 2>/dev/null)
    if [ -n "$SLON" ]; then
        ELON=$(echo "$SLON" | awk '{printf "%.5f", $1+0.15}')
        RESP=$(curl -s --max-time 20 "http://localhost:5000/route/v1/driving/$SLON,$SLAT;$ELON,$SLAT?overview=false")
        CODE=$(echo "$RESP" | jq -r '.code // "none"' 2>/dev/null)
        DIST=$(echo "$RESP" | jq -r '.routes[0].distance // 0' 2>/dev/null)
        log "    retry from ($SLAT,$SLON): code=$CODE distance=${DIST}m"
    fi
fi

if [ "$CODE" != "Ok" ] || [ "${DIST%.*}" -eq 0 ] 2>/dev/null; then
    log "GRAPH DOES NOT ROUTE — not claiming it is ready."
    log "A zero-distance 'Ok' means both points snapped to one edge, which is what"
    log "an empty or truncated graph looks like. Check build phases above."
    if [ -n "${SNAP_M:-}" ] && [ "$SNAP_M" -gt 50000 ] 2>/dev/null; then
        log "The nearest road to this extract's centre is $((SNAP_M / 1000))km away. For a"
        log "MERGED extract of separate regions the centre falls in the gap between them,"
        log "so verify with a point inside one region instead."
    fi
    exit 1
fi

log "=== OSRM READY on :5000 ==="
rm -f "$LOWFILE"
