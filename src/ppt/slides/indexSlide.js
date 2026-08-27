// ppt-slides/indexSlide.js

/**
 * Generates an index slide with a summary table of all warehouse options
 * @param {Object} pptx - PptxGenJS instance
 * @param {Array} warehouses - Array of warehouse objects
 */
function generateIndexSlide(pptx, warehouses) {
    const indexSlide = pptx.addSlide();
    indexSlide.background = { color: 'FFFFFF' };

    // Add slide title
    indexSlide.addText('INDEX', {
        x: 0.5,
        y: 0.5,
        w: '90%',
        h: 0.8,
        fontFace: 'Arial',
        fontSize: 28,
        bold: true,
        align: 'center',
        color: '000000'
    });

    // Handle empty warehouse array
    if (!warehouses || warehouses.length === 0) {
        indexSlide.addText('No warehouse options available', {
            x: 0.5,
            y: 3,
            w: '90%',
            h: 1,
            fontFace: 'Arial',
            fontSize: 18,
            align: 'center',
            color: '666666'
        });
        return;
    }

    // Create table data
    const tableData = createTableData(warehouses);

    // Table configuration
    const tableOptions = {
        x: 1.0, // Center the table better
        y: 1.5,
        w: 11.33, // Adjusted width for better centering
        border: { type: 'solid', pt: 1, color: 'CCCCCC' },
        fontSize: 11,
        fontFace: 'Arial',
        colW: [0.7, 1.3, 2.8, 2.8, 2.8, 1.3], // Better balanced column widths: S.No, Warehouse#, Location, Rental, Area, Availability
        rowH: 0.5,
        valign: 'middle',
        margin: 0.1
    };

    indexSlide.addTable(tableData, tableOptions);
}

/**
 * Creates table data from warehouse array
 * @param {Array} warehouses - Array of warehouse objects
 * @returns {Array} Table data with headers and rows
 */
function createTableData(warehouses) {
    // Header row with SNAP SHOTS styling
    const headerRow = [
        { text: 'S.No', options: { fill: '1f4e79', color: 'FFFFFF', bold: true, align: 'center' } },
        { text: 'Warehouse Number', options: { fill: '1f4e79', color: 'FFFFFF', bold: true, align: 'center' } },
        { text: 'Location', options: { fill: '1f4e79', color: 'FFFFFF', bold: true, align: 'center' } },
        { text: 'Quoted Monthly Rental (INR/Sq.ft)', options: { fill: '1f4e79', color: 'FFFFFF', bold: true, align: 'center' } },
        { text: 'Offered Area (Sq.ft)', options: { fill: '1f4e79', color: 'FFFFFF', bold: true, align: 'center' } },
        { text: 'Availability', options: { fill: '1f4e79', color: 'FFFFFF', bold: true, align: 'center' } }
    ];

    // Data rows with alternating colors
    const dataRows = warehouses.map((warehouse, index) => {
        const isEvenRow = index % 2 === 0;
        const rowColor = isEvenRow ? 'FFFFFF' : 'F5F5F5';
        
        return [
            { text: (index + 1).toString(), options: { fill: rowColor, align: 'center' } },
            { text: warehouse.id ? warehouse.id.toString() : 'N/A', options: { fill: rowColor, align: 'center' } },
            { text: formatLocation(warehouse), options: { fill: rowColor } },
            { text: formatRentalRate(warehouse.ratePerSqft), options: { fill: rowColor, align: 'center' } },
            { text: formatArea(warehouse.totalSpaceSqft), options: { fill: rowColor, align: 'center' } },
            { text: formatAvailability(warehouse.availability), options: { fill: rowColor, align: 'center' } }
        ];
    });

    return [headerRow, ...dataRows];
}

/**
 * Formats location from warehouse address
 * @param {Object} warehouse - Warehouse object
 * @returns {string} Formatted location string (address only)
 */
function formatLocation(warehouse) {
    const address = warehouse.address || '';
    
    if (address) {
        return address;
    } else {
        return 'N/A';
    }
}

/**
 * Formats rental rate with "/-" suffix
 * @param {string|number} ratePerSqft - Rate per square foot
 * @returns {string} Formatted rental rate
 */
function formatRentalRate(ratePerSqft) {
    if (!ratePerSqft || ratePerSqft === '') {
        return 'N/A';
    }
    
    // Remove any existing "/-" suffix and add it consistently
    const cleanRate = ratePerSqft.toString().replace('/-', '').trim();
    return `${cleanRate}/-`;
}

/**
 * Formats area from totalSpaceSqft array or single value
 * @param {Array|number|string} totalSpaceSqft - Area value(s)
 * @returns {string} Formatted area string
 */
function formatArea(totalSpaceSqft) {
    if (!totalSpaceSqft) {
        return 'N/A';
    }
    
    if (Array.isArray(totalSpaceSqft)) {
        if (totalSpaceSqft.length === 0) {
            return 'N/A';
        }
        // Join multiple areas with commas and format with thousand separators
        return totalSpaceSqft
            .map(area => formatNumberWithCommas(area))
            .join(', ');
    } else {
        // Single value
        return formatNumberWithCommas(totalSpaceSqft);
    }
}

/**
 * Formats numbers with comma separators for thousands
 * @param {number|string} num - Number to format
 * @returns {string} Formatted number string
 */
function formatNumberWithCommas(num) {
    if (!num && num !== 0) {
        return 'N/A';
    }
    
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Formats availability field
 * @param {string} availability - Availability value from warehouse
 * @returns {string} Formatted availability string
 */
function formatAvailability(availability) {
    if (!availability || availability === '') {
        return 'N/A';
    }
    
    return availability.toString().trim();
}

module.exports = { generateIndexSlide };