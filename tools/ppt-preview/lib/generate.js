const path = require('path');
const { backendRoot, VARIANTS } = require('../config');
const { startImageServer } = require('./imageServer');
const { installNetGuard } = require('./netGuard');
const {
  makeWarehouses, fixtureWarehouseModel, defaultCustomDetails, selectedImagesFor,
} = require('./fixtures');

const PptGenerationService = require(path.join(backendRoot, 'src/services/pptGenerationService'));

/**
 * Build decks the same way the API does.
 *
 * Goes through the real `PptGenerationService`, so the variant switch, the id
 * ordering and every deck builder under `src/ppt/**` are the code under test.
 * Only two things are swapped: the warehouse source (fixtures instead of Prisma,
 * unless `--db`) and the network (a local photo origin, everything else refused).
 *
 * Deliberately no HTTP and no auth — this is the generator, not the endpoint.
 * That is also what makes it usable on a deck that takes minutes: App Runner's
 * ~120s cap does not exist here.
 */

/**
 * Set up a session: photo origin, network guard, warehouses, service.
 *
 * @param {object} [opts]
 * @param {number} [opts.count]     - how many fixture warehouses to build
 * @param {number} [opts.imagePort] - 0 for an ephemeral port
 * @param {boolean} [opts.offline]  - refuse non-local HTTP (default true)
 * @param {boolean} [opts.useDb]    - load real warehouses via Prisma instead
 */
async function createSession({ count = 6, imagePort = 0, offline = true, useDb = false } = {}) {
  const images = await startImageServer({ port: imagePort });
  const guard = offline ? installNetGuard({ allowHosts: ['127.0.0.1', 'localhost'] }) : null;

  let warehouseModel;
  let prisma = null;
  let fixtures = [];

  if (useDb) {
    // Mirrors WarehouseModel.findManyForPpt exactly, without booting the
    // container: a preview against real data should see what the API sees.
    const { PrismaClient } = require(path.join(backendRoot, 'node_modules/@prisma/client'));
    prisma = new PrismaClient();
    warehouseModel = {
      findManyForPpt: (ids) => prisma.warehouse.findMany({
        where: { id: { in: ids } },
        include: { WarehouseData: true },
      }),
    };
  } else {
    fixtures = makeWarehouses({ imageBase: images.baseUrl, count });
    warehouseModel = fixtureWarehouseModel(fixtures);
  }

  const service = new PptGenerationService(warehouseModel);

  return {
    images,
    guard,
    fixtures,
    service,

    /** Ids to build a deck from: every fixture, or whatever the caller names. */
    defaultIds: fixtures.map((w) => w.id),

    /**
     * Build one deck.
     *
     * @param {string} variant - key of VARIANTS
     * @param {object} [opts]
     * @param {number[]} [opts.ids]
     * @param {object} [opts.customDetails]
     * @returns {Promise<{buffer: Buffer, warehouses: object[], durationMs: number}>}
     */
    async build(variant, { ids, customDetails = {} } = {}) {
      if (!VARIANTS[variant]) {
        throw new Error(`Unknown variant "${variant}". Known: ${Object.keys(VARIANTS).join(', ')}`);
      }

      const wanted = ids && ids.length ? ids : fixtures.map((w) => w.id);
      const warehouses = await service.findWarehousesByIds(wanted);

      // TCI is the one variant that tolerates an empty set, falling back to its
      // own placeholder warehouses.
      if (warehouses.length === 0 && variant !== 'tci') {
        throw new Error(`No warehouses found for ids ${wanted.join(', ')}`);
      }

      const startedAt = Date.now();
      const buffer = await service.createBuffer(
        variant,
        warehouses,
        selectedImagesFor(warehouses),
        defaultCustomDetails(customDetails),
      );

      return { buffer, warehouses, durationMs: Date.now() - startedAt };
    },

    async close() {
      if (guard) guard.restore();
      await images.close();
      if (prisma) await prisma.$disconnect();
    },
  };
}

module.exports = { createSession };
