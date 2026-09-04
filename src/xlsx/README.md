# Last Mile Excel export

`POST /api/generate-xlsx-last-mile` accepts the same `ids`, `selectedImages`, and
`customDetails` body as the client PPT routes. It uses their JWT + DASHBOARD gate,
ordered warehouse loading, and server-observed export audit (`variant: last-mile`).
The response is an XLSX buffer with the spreadsheet MIME type. The existing audit
entity remains `presentation` so exports stay together in dashboard history; the
context identifies this as a workbook. No client-reported audit is needed.

The layout follows **WH Options Indore 25,000sft in Indore - Last Mile (1)(1).xlsx**:
32 rows, the same row labels and three section bands, with properties in columns.
Up to four properties fit on each worksheet; subsequent worksheets continue the
option numbering in the requested ID order. All DB values are written as text,
including formula-like strings and rents, to avoid formulas or percentage formats.
The generator contains no sample property data and needs no template file at runtime.

The dashboard offers **Last Mile (Excel)** in the existing PPT Generator picker.
It accepts up to four selected photos per warehouse, omits PPT-only controls, and downloads
an `.xlsx` file. Images must belong to the listing's `photos`; absent, failed, or
unsupported photos show `Images NA`. Images are normalized to PNG and fitted without
distortion within the same Photographs cell: one uses the full space, two sit side
by side, and three/four use a 2x2 grid. Each image is anchored separately in that
cell. Failed photos are skipped; `Images NA` appears only if no photos load.
No photos are selected implicitly. Highway/rail/airport distances are read from
stored proximity records; generation makes no geospatial API calls.

## Field mapping

| Workbook row | Database source |
| --- | --- |
| Status band | `status` |
| Property Address; Location | `address` (the sample repeats the address) |
| Photographs | Up to four explicitly selected URLs from `photos`, arranged in the same cell |
| Distance from Railway | `WarehouseProximity.roadKm`, category `railway_station`, status `OK` |
| Distance from Airport | `WarehouseProximity.roadKm`, category `aerodrome`, status `OK` |
| Distance From Highway | Successful `WarehouseProximity.roadKm`, category `national_highway`; fallback to `distance_from_highway`. `ON_HIGHWAY` displays `Direct access`, matching PPT exports. |
| Developer Name; Comments | Always `NA` by request; consultants fill these in after downloading |
| Time frame for availability | Existing `formatHandover` for recorded handover fields; otherwise `availability` |
| Total Built up Area | `totalSpaceSqft` (dashboard Offered Area), explicitly requested for this Last Mile row. Multiple values are shown separately with `/`, not summed. |
| Total Land Area | `land_parcel_size`, retaining its recorded units |
| Connected & Sanctioned Electricity Load | `WarehouseData.powerKva` (the DB does not distinguish connected vs sanctioned) |
| Water Source & availability | `waterSupply` label; `NONE` means None, null means NA |
| Land Zoning | `WarehouseData.landType` |
| Floor Type | `flooringType` |
| Floor Loading | `floorStrengthPerSqm`, retaining its recorded units |
| Fire Fighting System/ Sprinklers | `WarehouseData.fireSafetyMeasures`; a fire NOC alone does not establish equipment |
| Number of Docks/exits | `numberOfDocks` (no inferred exit count) |
| Shed Height (Centre) | `centreHeight` |
| Shed Height (Eve/Side) | `clearHeightFt`, matching the existing TCI convention |
| Ventilation | `ventilationType` |
| Quoted Rent | `ratePerSqft` |
| Google Coordinated | `googleLocation`, or valid `WarehouseData.latitude/longitude` |

Unknown/blank/NA values remain `NA`; no facilities or immediate handover are
assumed when the underlying fields are absent. Units are appended only to bare
numbers in unit-specific fields. Stored airport/railway distances mean **nearest
landmark by road**, not distance to a client-designated station or airport.

## Mappings awaiting confirmation

- Roof Type: `warehouseType` describes the building, not necessarily the roof.
- Adjacent Occupiers, Plan Sanction, Office area: no dedicated fields found.

Those four rows currently show `NA`. Developer Name and Comments separately
remain `NA` intentionally for consultants to complete. No database migration is required.

## Verification

Run `npm test -- --runInBand tests/xlsx/lastMile.test.js tests/routes/lastMileExport.test.js tests/routes/pptAccess.test.js`.
The workbook tests load the generated XLSX, check mapping, format, worksheet
pagination, safe cell values, hyperlink handling, selected photos and failures.
Route tests exercise the real controller and generator with a stubbed database and
audit sink, and the shared access tests cover authenticated/capability-denied callers.
Frontend coverage lives in `LastMileExport.test.jsx` and `pptService.verify.test.js`.
