// src/controllers/geoController.js
const BaseController = require('./baseController');

/**
 * GeoController — map-view endpoints.
 *
 * The viewport reads return bare GeoJSON FeatureCollections rather than the
 * usual { success, data } envelope, because Mapbox consumes a FeatureCollection
 * directly as a source. Wrapping them would force the client to unwrap before
 * every setData() call for no benefit. The CRUD endpoints keep the envelope.
 */
class GeoController extends BaseController {
    constructor(geoService) {
        super();
        this.geoService = geoService;
    }

    /** GET /api/geo/osm-pois?bbox=w,s,e,n&categories=fuel,hospital&limit=2000 */
    osmPois = this.asyncHandler(async (req, res) => {
        const fc = await this.geoService.osmPois(req.query);
        return res.status(200).json(fc);
    });

    /** GET /api/geo/points?bbox=w,s,e,n&categories=&limit= — our own POIs */
    ownPois = this.asyncHandler(async (req, res) => {
        const fc = await this.geoService.ownPois(req.query);
        return res.status(200).json(fc);
    });

    /** GET /api/geo/warehouses?bbox=w,s,e,n&limit= */
    warehouses = this.asyncHandler(async (req, res) => {
        const fc = await this.geoService.warehouses(req.query);
        return res.status(200).json(fc);
    });

    /** GET /api/geo/layers — categories + counts for the toggle sidebar */
    layers = this.asyncHandler(async (req, res) => {
        const data = await this.geoService.layers();
        return res.status(200).json({ success: true, data });
    });

    /** POST /api/geo/points */
    createPoint = this.asyncHandler(async (req, res) => {
        const data = await this.geoService.createOwnPoi(req.body, req.user);
        return res.status(201).json({ success: true, data });
    });

    /** PUT /api/geo/points/:id */
    updatePoint = this.asyncHandler(async (req, res) => {
        const data = await this.geoService.updateOwnPoi(req.params.id, req.body, req.user);
        return res.status(200).json({ success: true, data });
    });

    /** DELETE /api/geo/points/:id */
    deletePoint = this.asyncHandler(async (req, res) => {
        const data = await this.geoService.deleteOwnPoi(req.params.id, req.user);
        return res.status(200).json({ success: true, data });
    });
}

module.exports = GeoController;
