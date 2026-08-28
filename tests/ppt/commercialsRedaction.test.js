const PptxGenJS = require('pptxgenjs');
const { createPptBufferV2 } = require('../../src/ppt/services/pptServiceV2');
const { generateIndexSlideV2 } = require('../../src/ppt/slides/v2/indexSlideV2');

/**
 * The `commercials: false` display flag must withhold the rent from the whole
 * deck, not just the per-property slides.
 *
 * It used to leak: pptServiceV2 called generateIndexSlideV2(pptx, warehouses)
 * without the flags, and the index slide rendered ratePerSqft unconditionally
 * under "Quoted Monthly Rental". So a deck built with "Include rent /
 * commercials" unticked in the dashboard's PPT modal redacted each property
 * slide and then printed every rate on the page right after the title. v2 is the
 * only variant the frontend sends these flags for, so it was reachable in
 * production.
 *
 * The assertions below match whole table cells rather than substrings — a rate of
 * 55 appears inside an area of 155,000 — and the "flag on" cases are the control:
 * without them a passing redaction check could just mean the matcher never finds
 * the rate at all.
 */

/** Every text value on a slide, flattened (tables included). */
function collectText(slide) {
    const out = [];
    const push = (v) => {
        if (v == null) return;
        if (Array.isArray(v)) return v.forEach(push);
        if (typeof v === 'object') return push(v.text);
        out.push(String(v));
    };
    for (const obj of slide._slideObjects || []) {
        push(obj.text);
        for (const row of obj.arrTabRows || []) push(row);
    }
    return out;
}

const RATE = '55';

const WAREHOUSE = {
    id: 1000,
    address: 'Plot 1, Bhiwandi Industrial Estate',
    city: 'Bhiwandi',
    state: 'Maharashtra',
    warehouseType: 'PEB',
    // Deliberately contains "55" as a substring: a substring match would report
    // a leak here even when the rent is properly redacted.
    totalSpaceSqft: [155000],
    ratePerSqft: RATE,
    numberOfDocks: '8',
    clearHeightFt: '32',
    compliances: 'Fire NOC',
    handoverType: 'IMMEDIATE',
    handoverDate: null,
    WarehouseData: { latitude: 19.2969, longitude: 73.0629, landType: 'Industrial' },
};

/** Cells whose entire text is the rate, in either spelling the deck uses. */
const rentCells = (slide) => collectText(slide)
    .filter((text) => text.trim() === RATE || text.trim() === `${RATE}/-`);

describe('index slide honours the commercials flag', () => {
    let pptx;

    beforeEach(() => {
        pptx = new PptxGenJS();
        pptx.layout = 'LAYOUT_16x9';
    });

    test('prints the rent when the flag is absent', () => {
        generateIndexSlideV2(pptx, [WAREHOUSE]);

        expect(rentCells(pptx.slides[0])).toEqual([`${RATE}/-`]);
    });

    test('prints the rent when commercials are on', () => {
        generateIndexSlideV2(pptx, [WAREHOUSE], { commercials: true });

        expect(rentCells(pptx.slides[0])).toEqual([`${RATE}/-`]);
    });

    test('withholds the rent when commercials are off', () => {
        generateIndexSlideV2(pptx, [WAREHOUSE], { commercials: false });

        const text = collectText(pptx.slides[0]);
        expect(rentCells(pptx.slides[0])).toEqual([]);
        expect(text).toContain('Available on Demand');
        // The column header stays — only the value is withheld.
        expect(text.join(' ')).toContain('Quoted Monthly Rental');
    });
});

describe('a v2 deck built with commercials off carries no rent anywhere', () => {
    /** Slide indexes whose XML contains the rate as a complete text run. */
    async function slidesShowingRent(customDetails) {
        const buffer = await createPptBufferV2([WAREHOUSE], {}, customDetails);
        // jszip is pptxgenjs's own declared dependency, so it is installed wherever
        // the deck builders are.
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(buffer);

        const found = [];
        const names = Object.keys(zip.files)
            .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
            .sort();

        for (const name of names) {
            const xml = await zip.file(name).async('string');
            const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1].trim());
            if (runs.some((run) => run === RATE || run === `${RATE}/-`)) found.push(name);
        }
        return found;
    }

    test('prints it on two slides when commercials are on', async () => {
        // Control: the index slide and the property slide, so the check below is
        // known to be capable of finding a leak.
        expect(await slidesShowingRent({ commercials: true })).toHaveLength(2);
    });

    test('prints it on no slide when commercials are off', async () => {
        expect(await slidesShowingRent({ commercials: false })).toEqual([]);
    });
}, 30_000);

describe('the flag survives the HTTP layer', () => {
    /**
     * The last link the checks above do not cover: express parsing the body, the
     * controller destructuring `customDetails` off it, and the generation service
     * handing it to the deck builder. Mounts the real controller over the real
     * generation service with a fixture warehouse model, so everything between
     * the request body and the returned bytes is the production path — only the
     * database and the audit sink are substituted.
     */
    const express = require('express');
    const request = require('supertest');
    const PptController = require('../../src/controllers/pptController');
    const PptGenerationService = require('../../src/services/pptGenerationService');

    function makeApp() {
        const model = { findManyForPpt: async () => [WAREHOUSE] };
        const controller = new PptController(new PptGenerationService(model), { log: () => {} });
        const app = express();
        app.use(express.json({ limit: '10mb' }));
        app.post('/api/generate-ppt-v2', controller.handleGenerate({ variant: 'v2', label: 'v2' }));
        return app;
    }

    /** POST the route and return the .pptx bytes. */
    const generate = (customDetails) => request(makeApp())
        .post('/api/generate-ppt-v2')
        .send({ ids: String(WAREHOUSE.id), selectedImages: {}, customDetails })
        .buffer(true)
        .parse((res, cb) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => cb(null, Buffer.concat(chunks)));
        });

    async function slidesShowingRentInBuffer(buffer) {
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(buffer);
        const found = [];
        const names = Object.keys(zip.files)
            .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
            .sort();
        for (const name of names) {
            const xml = await zip.file(name).async('string');
            const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1].trim());
            if (runs.some((run) => run === RATE || run === `${RATE}/-`)) found.push(name);
        }
        return found;
    }

    test('a request with commercials on returns a deck that shows the rent', async () => {
        const res = await generate({ clientName: 'Acme Logistics' });

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toContain('presentationml.presentation');
        // Control: the index slide and the property slide.
        expect(await slidesShowingRentInBuffer(res.body)).toHaveLength(2);
    });

    test('a request with commercials off returns a deck with no rent on it', async () => {
        const res = await generate({ clientName: 'Acme Logistics', commercials: false });

        expect(res.status).toBe(200);
        expect(await slidesShowingRentInBuffer(res.body)).toEqual([]);
    });
}, 30_000);
