#!/bin/bash
# Sweep the remaining India zones one at a time: build a graph, measure every
# warehouse it covers, throw the graph away, move on.
#
# WHY SEQUENTIALLY AND NOT ONE NATIONAL GRAPH. Measured, not assumed: the
# southern zone's osrm-extract peaked at 13.45GB on a 221MB filtered input, and
# the national extract is 1626MB — 3x the zone once filtered, so ~41GB against
# 30GB of physical RAM, with ~18GB of artefacts against 12GB of free disk. It
# fails on both counts. One zone at a time peaks at ~14GB and ~7GB, which fits,
# and the highway metric is uniquely suited to it because its search radius is
# 10km: nothing outside the zone can affect the answer except within 10km of a
# border.
#
# The next zone's extract downloads WHILE the current one builds and runs, since
# geofabrik is the slow part (~20 min a zone) and the build is CPU-bound.
#
# BORDER CAVEAT, deliberately not solved here: a warehouse within 10km of a zone
# edge may have its true nearest entry in the neighbouring zone and will get a
# slightly-too-long answer. Those are identifiable afterwards from the zone
# bounding boxes and can be re-measured against the adjacent zone.
set -u

# Resolved from this script's own location, so a checkout anywhere works.
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BACKEND=$(cd "$HERE/../.." && pwd)
WORKDIR=${OSRM_WORKDIR:-$HOME/osrm-data}
mkdir -p "$WORKDIR"
cd "$WORKDIR" || exit 1
# Overridable, so a run that dropped zones can be resumed for just those:
#   ./run-zones.sh central-zone north-eastern-zone
if [ "$#" -gt 0 ]; then ZONES=("$@"); else
ZONES=(northern-zone western-zone eastern-zone central-zone north-eastern-zone)
fi
BASE_URL=https://download.geofabrik.de/asia/india

log () { echo "[$(date +%H:%M:%S)] $*"; }

# -L matters: geofabrik 302-redirects -latest to a dated filename, and without it
# curl saves a 253-byte redirect page that passes every size check downstream.
fetch () {
    local z=$1
    [ -f "$z-latest.osm.pbf" ] && [ -f "$z-latest.osm.pbf.md5" ] && return 0
    curl -sS -L --retry 8 --retry-delay 10 --retry-all-errors --max-time 5400 \
        -o "$z-latest.osm.pbf" "$BASE_URL/$z-latest.osm.pbf" || return 1
    curl -sS -L -o "$z-latest.osm.pbf.md5" "$BASE_URL/$z-latest.osm.pbf.md5" || return 1
}

# Kick off the first download, then prefetch each subsequent zone in the
# background while the current one is being built and measured.
log "prefetching ${ZONES[0]}"
fetch "${ZONES[0]}"

for i in "${!ZONES[@]}"; do
    Z=${ZONES[$i]}
    NEXT=${ZONES[$((i + 1))]:-}

    if [ -n "$NEXT" ]; then
        log "prefetching $NEXT in the background"
        ( fetch "$NEXT" >/dev/null 2>&1 ) &
    fi

    log "=========== $Z ==========="

    # Drop every graph that is not this zone's. The southern graph was built
    # outside this script, so nothing in the loop would ever remove it, and two
    # graphs do not fit: 5.8GB each against 11GB free. Done here rather than once
    # up front so a resumed run also reclaims whatever the last zone left.
    for stale in *-roads.osrm*; do
        case "$stale" in
            "$Z"-latest-roads.osrm*) : ;;
            \*-roads.osrm\*) : ;;
            *) rm -f "$stale" ;;
        esac
    done
    for stale in *-latest-roads.osm.pbf; do
        [ "$stale" = "$Z-latest-roads.osm.pbf" ] || rm -f "$stale"
    done
    log "$Z: $(df -h . | awk 'NR==2{print $4}') free after clearing old graphs"

    # WAIT for the prefetch rather than skipping it.
    #
    # This is the bug that dropped central-zone and north-eastern-zone on the
    # first run. The prefetch runs in a background subshell and the loop went
    # straight to the md5 check; eastern-zone finished in 9 minutes, central was
    # 147MB of ~250MB, the checksum failed, and the zone was SKIPPED rather than
    # waited for — after which the script cheerfully announced "all zones done".
    #
    # A failing checksum on a file that is still growing means "not yet", not
    # "broken". So: poll while it grows, and only give up once it has stopped
    # growing AND still fails.
    WAITED=0
    while ! md5sum -c "$Z-latest.osm.pbf.md5" >/dev/null 2>&1; do
        SZ1=$(stat -c%s "$Z-latest.osm.pbf" 2>/dev/null || echo 0)
        sleep 30
        SZ2=$(stat -c%s "$Z-latest.osm.pbf" 2>/dev/null || echo 0)
        WAITED=$((WAITED + 30))
        if [ "$SZ2" -gt "$SZ1" ]; then
            [ $((WAITED % 300)) -eq 0 ] && log "$Z: still downloading, $(( SZ2 / 1024 / 1024 )) MB after ${WAITED}s"
            continue
        fi
        # Not growing. Give the retry logic in curl a chance, then conclude.
        if [ "$WAITED" -ge 180 ]; then
            log "$Z: download stalled at $(( SZ2 / 1024 / 1024 )) MB and checksum fails — skipping"
            break
        fi
    done
    if ! md5sum -c "$Z-latest.osm.pbf.md5" >/dev/null 2>&1; then
        continue
    fi
    log "$Z: $(( $(stat -c%s "$Z-latest.osm.pbf") / 1024 / 1024 )) MB, checksum OK"

    RAW="$Z-latest.osm.pbf" MIN_MB=50 THREADS=4 OSRM_WORKDIR="$WORKDIR" \
        "$HERE/build-osrm.sh" >"build-$Z.log" 2>&1
    if ! grep -q "OSRM READY" "build-$Z.log"; then
        log "$Z: BUILD FAILED — see build-$Z.log"
        grep -E "KILLED|FAILED|MISMATCH|TRUNCATED" "build-$Z.log" | head -3
        rm -f "$Z-latest-roads.osrm"* "$Z-latest-roads.osm.pbf"
        continue
    fi
    log "$Z: graph serving; measuring warehouses"

    ( cd "$BACKEND" && node -r dotenv/config tools/highway-entry/probe.js \
        --limit=3000 --sample-m=100 --out="zone-$Z.jsonl" ) >"probe-$Z.log" 2>&1
    N=$(grep -c '^wh' "probe-$Z.log" 2>/dev/null || echo 0)
    log "$Z: measured $N warehouses"

    # Backfilled per zone, not once at the end. Each zone's graph is destroyed to
    # make room for the next, so an unwritten measurement would cost a rebuild —
    # and tonight a rebuild means re-downloading through a throttled mirror.
    if [ "$N" -gt 0 ]; then
        ( cd "$BACKEND" && node -r dotenv/config scripts/backfillHighwayEntry.js \
            --in="tools/highway-entry/zone-$Z.jsonl" ) >"backfill-$Z.log" 2>&1
        log "$Z: backfill -> $(grep -E '^updated' "backfill-$Z.log" | head -1)"
    fi

    # Reclaim before the next zone; 12GB free will not hold two graphs.
    rm -f "$Z-latest-roads.osrm"* "$Z-latest-roads.osm.pbf" "$Z-latest.osm.pbf"
    log "$Z: artefacts removed, $(df -h . | awk 'NR==2{print $4}') free"
done

log "=========== all zones done ==========="
for f in "$BACKEND"/tools/highway-entry/zone-*.jsonl; do
    [ -f "$f" ] && echo "  $(basename "$f"): $(wc -l < "$f") warehouses"
done
