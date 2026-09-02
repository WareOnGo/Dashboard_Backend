# Highway entry distances

How to recompute the drive distance from every warehouse to its nearest numbered
highway. Everything here was run end to end on 2–3 Sep 2026; the numbers quoted
are what it actually produced, so a re-run that disagrees wildly is a signal.

## Why this is not a one-line query

A highway is a **line**, so "distance to it" has no endpoint to route to. The
pipeline used to report the designation only — `NH44` with no kilometres — and the
stated reason was that 94.3% of India's numbered-highway mileage is `trunk` or
`primary` rather than access-controlled, so OSM has no reason to tag the ordinary
crossroads where you actually join.

That reason was incomplete. **The junctions are not missing from OSM; they are
missing as tags.** Wherever a local road meets NH44 the two ways share a node,
which is exactly why routing works at all. A router can therefore find a real,
legal entry without anyone having labelled it. What blocked us was never the data:

- a shortlist of *tagged* points cannot ask the question, and
- sampling the line costs one routing call per sample.

Measured: ~915 samples per warehouse, so **1.4 million legs** for the fleet. That
is 14× Mapbox's monthly free tier and roughly $700 metered — and free on a local
engine. Hence all the OSRM machinery.

We tried the tagged route first. `osm_poi.category = 'highway_access'` holds 19,860
nodes; routing to those **overstates by a median 1.31 km with only 30% inside
500 m**, against answers that are typically 1–3 km. They cannot answer this.

## What you cannot do on a laptop

Measured, not assumed:

| | southern zone | national |
|---|---|---|
| raw extract | 532 MB | 1626 MB |
| filtered (`w/highway`) | 221 MB | ~675 MB |
| `osrm-extract` peak RAM | **13.45 GB** | **~41 GB** |
| graph artefacts | 5.8 GB | ~18 GB |

A single national graph needs ~41 GB against 30 GB physical here, and ~18 GB of
artefacts against ~12 GB free. It fails on both. **Do it one zone at a time**,
which peaks at ~14 GB RAM and ~7 GB disk. This works for *this* metric because its
search radius is 10 km — nothing outside a zone can change an answer except within
10 km of a border. It does **not** generalise to the other proximity categories,
whose radii reach 300 km.

If you want one national graph, build it on a rented box (32 GB, about an hour)
and either serve it there with `OSRM_ENDPOINT` pointed at it, or pull the ~18 GB of
artefacts down.

## Prerequisites

```bash
sudo dnf install -y osmium-tool     # the filter step; not optional, see below
podman --version                     # ghcr.io/project-osrm/osrm-backend
jq --version                         # the build script's verification step
df -h /                              # need ~8 GB free per zone
free -g                              # need ~15 GB available during extract
```

`osmium tags-filter` is what makes this fit. `osrm-extract`'s peak memory is
dominated by the node-location cache, which holds coordinates for every node any
way references, and the full extract carries buildings, landuse and coastline that
routing never reads. Filtering to `w/highway r/type=restriction` cuts the file to
~41% and the cache with it. The Lua profile cannot do this — it runs *after* the
cache is built. Turn restrictions are kept deliberately: without them the router
invents illegal turns and every distance comes out quietly optimistic.

## Running it

```bash
# All six zones, sequentially. ~10 min a zone plus download.
tools/osrm/run-zones.sh southern-zone northern-zone western-zone \
                        eastern-zone central-zone north-eastern-zone

# Or one zone by hand:
OSRM_WORKDIR=~/osrm-data RAW=southern-zone-latest.osm.pbf MIN_MB=400 \
  tools/osrm/build-osrm.sh

node -r dotenv/config tools/highway-entry/probe.js \
  --limit=3000 --sample-m=100 --out=zone-southern-zone.jsonl

node -r dotenv/config scripts/backfillHighwayEntry.js \
  --in=tools/highway-entry/zone-southern-zone.jsonl --create-missing
```

`run-zones.sh` does all of that per zone and then deletes the graph, because two
graphs do not fit. It backfills **after each zone** rather than at the end: the
graph is destroyed to make room for the next, so an unwritten measurement costs a
rebuild, and a rebuild means re-downloading.

Then export for humans:

```bash
cat tools/highway-entry/zone-*.jsonl > tools/highway-entry/all-zones.jsonl
node tools/highway-entry/export-csv.js tools/highway-entry/all-zones.jsonl
# -> highway-entry.csv    the distance per warehouse
# -> coord-suspects.csv   pins >150m from any road, for QA
```

## How the measurement works

`probe.js`, per warehouse:

1. **Coverage check.** `/nearest` on the warehouse. If it snapped >3 km, the
   warehouse is outside this graph — skip. OSRM never says "outside my data"; it
   snaps to the nearest edge it has and returns confident nonsense, so this guard
   is what keeps other zones' warehouses out of the statistics.
2. **Straight-line nearest** highway, for comparison (`ORDER BY geog <-> origin`).
3. **Two-pass bounded sampling.** Densify nearby highways into points every
   `--sample-m` metres and route to all of them in one `/table` call.
   - Pass 1 samples only near the straight-line-nearest way, giving an upper
     bound X.
   - Pass 2 widens to X, because **road distance is never shorter than
     straight-line**, so no highway further than X in a straight line can win.

   X is usually under 3 km, so pass 2 reads a fraction of the geometry. This is
   exact and needs no cap.
4. **Snap check on the winner.** A sample sits on the centreline; OSRM may snap it
   to a parallel service road, which would measure that road instead. Winners
   snapping >50 m are recorded as `snapSuspect` and the backfill refuses them.

## Expected results (2–3 Sep 2026)

| | |
|---|---|
| warehouses measured | 1,544 across 6 zones (1,537 distinct) |
| stored | 1,537 |
| drive distance | median **1.29 km**, mean 1.74, max 8.64 |
| extra vs straight line | median **+0.40 km** |
| winner snap | median 1.5 m; 6 of 1,544 over 50 m (rejected) |
| designation corrected | **157 (10.2%)** |
| pins >150 m from a road | 91 |
| access on the carriageway | 12 (`ON_HIGHWAY`) |
| legs routed | ~250k, free |

Per zone: southern 972, western 256, northern 123, central 98, eastern 90,
north-eastern 5.

**Designation corrected** is worth understanding: for 10% of warehouses the
highway nearest by *road* is not the one nearest by straight line, so the ref the
deck printed before this work was also wrong, not just the missing distance. The
backfill overwrites `landmarkName` and `poiId` along with the distance — a correct
number attached to the wrong road is worse than either error alone.

## Traps that cost real time

Each of these cost 20 minutes or more. They are all still live.

1. **`curl` needs `-L`.** Geofabrik 302-redirects `-latest` to a dated filename.
   Without it you save a 253-byte redirect page that passes every size check.
2. **Verify the md5.** A 1023 MB download of the national extract passed a size
   floor *and* the `OSMHeader` magic-byte check, and was corrupt — `curl` exited 0.
   Only the checksum caught it. `osmium fileinfo -e` also catches it, by reading to
   the end ("unexpected EOF").
3. **Node buffers stdout to a pipe in 64 KB chunks.** A working probe piped to
   `grep` looks stalled for minutes. Redirect to a file instead.
4. **A zero-distance route reports `code: "Ok"`.** The build script's verification
   originally routed between two fixed Bengaluru coordinates; against the northern
   graph both snapped to the same edge and it returned `Ok` with `distance: 0`,
   then printed "OSRM READY". An empty graph looks identical. The check now derives
   its test point from the extract's own bbox and treats zero as failure.
5. **Don't `LIMIT` samples without `ORDER BY`.** An early optimisation dropped the
   per-point distance ordering to save time; `LIMIT` then kept an arbitrary subset,
   which can exclude the nearest highway entirely. The answers still matched, which
   was luck. The two-pass bound removed the need for a cap at all.
6. **Wait for a prefetch, don't skip it.** `run-zones.sh` downloads the next zone
   in the background. The first version went straight to the md5 check, so a zone
   still downloading failed the check and was **skipped** — after which the script
   announced "all zones done" having silently dropped two zones. It now polls while
   the file is growing.
7. **Write in bulk.** The backfill originally issued one `updateMany` per
   warehouse: ~600 ms of pooler round trip each, **13 minutes** to store data that
   was already computed. As `UPDATE ... FROM (VALUES …)` it is **8 seconds**.
8. **The pooler refuses connections intermittently.** Everything that touches the
   database retries. A read-only probe is not exempt — the first run died on its
   first query.

## Known gaps, deliberately not fixed

- **Zone borders.** A warehouse within 10 km of a zone edge may have its true
  nearest entry in the neighbouring zone and gets a slightly-too-long answer.
  Warehouses measured in two zones keep the **shorter** distance, which handles the
  overlap but not the general case. Identifiable from the zone bounding boxes.
- **Three warehouses have no distance**: 2038, 2488, 2489. Their pins are more than
  3 km from any mapped road — 2038's coordinate is about 30 km west of Navi Mumbai,
  in the bay. These are coordinate defects; forcing a number would measure from
  wherever the router chose to put them.
- **`originSnapM` is recorded and deliberately NOT added to `roadKm`.** OSRM
  measures between snapped endpoints, so the distance already starts from the
  nearest road position — a fair proxy for the gate, since a warehouse pin normally
  marks the compound. Adding it back would double-count the yard. Beyond 150 m the
  pin is not a compound centre, which is why that becomes a QA flag instead.
- **`node_modules`-level reproducibility of the OSM data.** A Geofabrik extract has
  a vintage. Re-running in a few months will produce slightly different numbers
  because the map changed, not because the method did.

## Comparing against Mapbox

`tools/routing-compare/compare.js` exists to answer "would switching backends
change the numbers". It changes one variable at a time, which matters — a single
combined figure cannot tell you whether the engine or the candidate set moved.

Measured over 2,300 comparisons: the k=20 shortlist finds the true nearest
landmark **99.2%** of the time, so self-hosting is not an accuracy fix. Engine
divergence is under 0.5 km for local categories, 2.05 km for airports and 6.13 km
for ports — long routes cross more chances for two maps to disagree.
