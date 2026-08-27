// ppt-slides/detailedSlide.js
const axios = require('axios');
const { logError, logWarn } = require('../utils/logger');
const { normalizeImageBuffer } = require('../utils/image');

/**
 * Generate detailed slides for a warehouse - split into location and technical slides
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} warehouse - Enriched warehouse object with geospatial data
 * @param {number} optionIndex - Option number for this warehouse
 */
async function generateDetailedSlide(pptx, warehouse, optionIndex) {
  // Check if Google location (coordinates) is available
  const hasLocation = warehouse.googleLocation &&
    warehouse.googleLocation.trim() !== '' &&
    warehouse.googleLocation !== 'N/A';

  // Generate Slide 1: Location slide only if Google location is available
  if (hasLocation) {
    await generateLocationSlide(pptx, warehouse, optionIndex);
  }

  // Generate Slide 2: Technical slide (always shown)
  await generateTechnicalSlide(pptx, warehouse, optionIndex);
}

/**
 * Generate location slide with distance highlights, address, satellite image, and placeholder image
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} warehouse - Enriched warehouse object with geospatial data
 * @param {number} optionIndex - Option number for this warehouse
 */
async function generateLocationSlide(pptx, warehouse, optionIndex) {
  const slide = pptx.addSlide();
  slide.background = { color: 'FFFFFF' };

  // Add slide title: "Warehouse #X"
  const title = `Warehouse #${warehouse.id}`;
  slide.addText(title, {
    x: 0.3,
    y: 0.3,
    w: 12.5,
    h: 0.5,
    fontFace: 'Verdana',
    fontSize: 20,
    bold: true,
    color: '1F4788'
  });

  // Left column for tables
  const leftColumnX = 0.3;
  const leftColumnW = 6.5;
  let currentY = 1.0;

  // Render distance highlights and address
  currentY = renderDistanceHighlights(slide, warehouse, leftColumnX, currentY, leftColumnW);
  currentY = renderAddress(slide, warehouse, leftColumnX, currentY, leftColumnW);

  // Add placeholder image below the tables in the left column
  renderPlaceholderImage(pptx, slide, leftColumnX, currentY, leftColumnW);

  // Right column for satellite image - larger and more prominent
  const rightColumnX = 7.2;
  const rightColumnW = 5.8;
  await renderSatelliteImage(pptx, slide, warehouse, rightColumnX, 1.0, rightColumnW);
}

/**
 * Generate technical slide with technical details, commercials, and warehouse image
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} warehouse - Enriched warehouse object with geospatial data
 * @param {number} optionIndex - Option number for this warehouse
 */
async function generateTechnicalSlide(pptx, warehouse, optionIndex) {
  const slide = pptx.addSlide();
  slide.background = { color: 'FFFFFF' };

  // Add slide title: "Warehouse #X"
  const title = `Warehouse #${warehouse.id}`;
  slide.addText(title, {
    x: 0.3,
    y: 0.3,
    w: 12.5,
    h: 0.5,
    fontFace: 'Verdana',
    fontSize: 20,
    bold: true,
    color: '1F4788'
  });

  // Left column for tables
  const leftColumnX = 0.3;
  const leftColumnW = 6.5;
  let currentY = 1.0;

  // Render technical details and commercials
  currentY = renderTechnicalDetails(slide, warehouse, leftColumnX, currentY, leftColumnW);
  renderCommercials(slide, warehouse, leftColumnX, currentY, leftColumnW);

  // Right column for warehouse image
  const rightColumnX = 7.2;
  const rightColumnW = 5.8;
  await renderWarehouseImage(pptx, slide, warehouse, rightColumnX, 1.0, rightColumnW);
}

/**
 * Render distance highlights section
 * @param {Object} slide - Slide object
 * @param {Object} warehouse - Warehouse object
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Section width
 * @returns {number} New Y position after this section
 */
function renderDistanceHighlights(slide, warehouse, x, y, width) {
  // Section header - aligned with table content (accounting for cell margin)
  slide.addText('Distance Highlights', {
    x: x - 0.05,
    y: y,
    w: width,
    h: 0.3,
    fontFace: 'Verdana',
    fontSize: 12,
    bold: true,
    color: '1F4788'
  });

  y += 0.35;

  // Prepare distance data
  const geospatial = warehouse.geospatial || {};
  const airportName = geospatial.nearestAirport?.name || 'N/A';
  const airportDistance = geospatial.nearestAirport
    ? `${geospatial.nearestAirport.distance} km`
    : 'N/A';
  const highwayName = geospatial.nearestHighway?.name || 'N/A';
  const highwayDistance = geospatial.nearestHighway
    ? `${geospatial.nearestHighway.distance} km`
    : 'N/A';
  const railwayName = geospatial.nearestRailway?.name || 'N/A';
  const railwayDistance = geospatial.nearestRailway
    ? `${geospatial.nearestRailway.distance} km`
    : 'N/A';

  const distanceData = [
    [
      { text: 'Nearest Airport', options: { bold: true, fontSize: 9 } },
      { text: `${airportName} (${airportDistance})`, options: { fontSize: 9 } }
    ],
    [
      { text: 'Nearest Highway', options: { bold: true, fontSize: 9 } },
      { text: `${highwayName} (${highwayDistance})`, options: { fontSize: 9 } }
    ],
    [
      { text: 'Nearest Railway', options: { bold: true, fontSize: 9 } },
      { text: `${railwayName} (${railwayDistance})`, options: { fontSize: 9 } }
    ],
    [
      { text: 'Approach Road', options: { bold: true, fontSize: 9 } },
      { text: 'TBD', options: { fontSize: 9 } }
    ]
  ];

  slide.addTable(distanceData, {
    x: x,
    y: y,
    w: width,
    border: { type: 'solid', pt: 1, color: 'DDDDDD' },
    fill: { color: 'F8F9FA' },
    fontFace: 'Verdana',
    colW: [width * 0.32, width * 0.68],
    rowH: 0.26,
    valign: 'middle',
    margin: 0.05
  });

  return y + (distanceData.length * 0.26) + 0.3;
}

/**
 * Render address section
 * @param {Object} slide - Slide object
 * @param {Object} warehouse - Warehouse object
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Section width
 * @returns {number} New Y position after this section
 */
function renderAddress(slide, warehouse, x, y, width) {
  // Section header - aligned with table content (accounting for cell margin)
  slide.addText('Address', {
    x: x - 0.05,
    y: y,
    w: width,
    h: 0.3,
    fontFace: 'Verdana',
    fontSize: 12,
    bold: true,
    color: '1F4788'
  });

  y += 0.35;

  // Address as single row with all information combined
  const address = warehouse.address || 'N/A';
  const city = warehouse.city || 'N/A';
  const state = warehouse.state || 'N/A';
  const fullAddress = `${address}, ${city}, ${state}`;

  const addressData = [
    [
      { text: 'Address', options: { bold: true, fontSize: 9 } },
      { text: fullAddress, options: { fontSize: 9 } }
    ]
  ];

  slide.addTable(addressData, {
    x: x,
    y: y,
    w: width,
    border: { type: 'solid', pt: 1, color: 'DDDDDD' },
    fill: { color: 'F8F9FA' },
    fontFace: 'Verdana',
    colW: [width * 0.13, width * 0.87],
    rowH: 0.26,
    valign: 'middle',
    margin: 0.05
  });

  return y + 0.26 + 0.3;
}

/**
 * Render technical details section
 * @param {Object} slide - Slide object
 * @param {Object} warehouse - Warehouse object
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Section width
 * @returns {number} New Y position after this section
 */
function renderTechnicalDetails(slide, warehouse, x, y, width) {
  // Section header - aligned with table content (accounting for cell margin)
  slide.addText('Technical Details', {
    x: x - 0.05,
    y: y,
    w: width,
    h: 0.3,
    fontFace: 'Verdana',
    fontSize: 12,
    bold: true,
    color: '1F4788'
  });

  y += 0.35;

  // Prepare technical details data
  const warehouseData = warehouse.WarehouseData || {};

  // Carpet area from totalSpaceSqft (join array with commas)
  const carpetArea = Array.isArray(warehouse.totalSpaceSqft)
    ? warehouse.totalSpaceSqft.join(', ') + ' sqft'
    : (warehouse.totalSpaceSqft ? warehouse.totalSpaceSqft + ' sqft' : 'N/A');

  const technicalData = [
    [
      { text: 'Carpet Area', options: { bold: true, fontSize: 9 } },
      { text: carpetArea, options: { fontSize: 9 } }
    ],
    [
      { text: 'Land Type', options: { bold: true, fontSize: 9 } },
      { text: warehouseData.landType || 'N/A', options: { fontSize: 9 } }
    ],
    [
      { text: 'Construction Type', options: { bold: true, fontSize: 9 } },
      { text: warehouse.warehouseType || 'N/A', options: { fontSize: 9 } }
    ],
    [
      { text: 'Side Height', options: { bold: true, fontSize: 9 } },
      { text: warehouse.clearHeightFt || 'N/A', options: { fontSize: 9 } }
    ],
    [
      { text: 'Centre Height', options: { bold: true, fontSize: 9 } },
      { text: 'TBD', options: { fontSize: 9 } }
    ],
    [
      { text: 'Dimensions', options: { bold: true, fontSize: 9 } },
      { text: 'TBD', options: { fontSize: 9 } }
    ],
    [
      { text: 'Flooring Type', options: { bold: true, fontSize: 9 } },
      { text: 'TBD', options: { fontSize: 9 } }
    ],
    [
      { text: 'Load Bearing', options: { bold: true, fontSize: 9 } },
      { text: 'TBD', options: { fontSize: 9 } }
    ],
    [
      { text: 'Dock Height', options: { bold: true, fontSize: 9 } },
      { text: 'TBD', options: { fontSize: 9 } }
    ],
    [
      { text: 'Dock Shutter', options: { bold: true, fontSize: 9 } },
      { text: 'TBD', options: { fontSize: 9 } }
    ],
    [
      { text: 'Emergency Exits', options: { bold: true, fontSize: 9 } },
      { text: 'TBD', options: { fontSize: 9 } }
    ],
    [
      { text: 'Fire Safety', options: { bold: true, fontSize: 9 } },
      { text: warehouseData.fireSafetyMeasures || 'N/A', options: { fontSize: 9 } }
    ],
    [
      { text: 'Power', options: { bold: true, fontSize: 9 } },
      { text: warehouseData.powerKva || 'N/A', options: { fontSize: 9 } }
    ],
    [
      { text: 'Amenities', options: { bold: true, fontSize: 9 } },
      { text: warehouse.otherSpecifications || 'N/A', options: { fontSize: 9 } }
    ]
  ];

  slide.addTable(technicalData, {
    x: x,
    y: y,
    w: width,
    border: { type: 'solid', pt: 1, color: 'DDDDDD' },
    fill: { color: 'F8F9FA' },
    fontFace: 'Verdana',
    colW: [width * 0.32, width * 0.68],
    rowH: 0.22,
    valign: 'middle',
    margin: 0.04
  });

  return y + (technicalData.length * 0.22) + 0.5;
}

/**
 * Render commercials section
 * @param {Object} slide - Slide object
 * @param {Object} warehouse - Warehouse object
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Section width
 */
function renderCommercials(slide, warehouse, x, y, width) {
  // Section header - aligned with table content (accounting for cell margin)
  slide.addText('Commercials', {
    x: x - 0.05,
    y: y,
    w: width,
    h: 0.3,
    fontFace: 'Verdana',
    fontSize: 12,
    bold: true,
    color: '1F4788'
  });

  y += 0.35;

  // Prepare commercials data
  const rentPerSqft = warehouse.ratePerSqft
    ? `₹${warehouse.ratePerSqft}`
    : 'N/A';

  const commercialsData = [
    [
      { text: 'Rent per sqft', options: { bold: true, fontSize: 10 } },
      { text: rentPerSqft, options: { fontSize: 10 } }
    ],
    [
      { text: 'Deposit', options: { bold: true, fontSize: 10 } },
      { text: 'TBD', options: { fontSize: 10 } }
    ],
    [
      { text: 'Lock-in', options: { bold: true, fontSize: 10 } },
      { text: 'TBD', options: { fontSize: 10 } }
    ],
    [
      { text: 'Escalation', options: { bold: true, fontSize: 10 } },
      { text: '5% YoY', options: { fontSize: 10 } }
    ],
    [
      { text: 'Notice Period', options: { bold: true, fontSize: 10 } },
      { text: 'TBD', options: { fontSize: 10 } }
    ]
  ];

  slide.addTable(commercialsData, {
    x: x,
    y: y,
    w: width,
    border: { type: 'solid', pt: 1, color: 'DDDDDD' },
    fill: { color: 'F8F9FA' },
    fontFace: 'Verdana',
    colW: [width * 0.32, width * 0.68],
    rowH: 0.26,
    valign: 'middle',
    margin: 0.05
  });
}

/**
 * Render placeholder image for layout purposes (smaller version for location slide)
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} slide - Slide object
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Image width
 */
function renderPlaceholderImage(pptx, slide, x, y, width) {
  const imageHeight = 2.5; // Smaller height for location slide

  // Add section header - aligned with placeholder content
  slide.addText('Warehouse Layout', {
    x: x - 0.05,
    y: y,
    w: width,
    h: 0.3,
    fontFace: 'Verdana',
    fontSize: 12,
    bold: true,
    color: '1F4788'
  });

  y += 0.35;

  // Display placeholder rectangle with light gray background
  slide.addShape(pptx.shapes.RECTANGLE, {
    x: x,
    y: y,
    w: width,
    h: imageHeight,
    fill: { color: 'F5F5F5' },
    line: { color: 'DDDDDD', width: 1 }
  });

  slide.addText('Image placeholder', {
    x: x,
    y: y + (imageHeight / 2) - 0.25,
    w: width,
    h: 0.5,
    align: 'center',
    valign: 'middle',
    fontSize: 11,
    color: 'AAAAAA'
  });
}

/**
 * Render warehouse image on the technical slide
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} slide - Slide object
 * @param {Object} warehouse - Warehouse object
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Image width
 */
async function renderWarehouseImage(pptx, slide, warehouse, x, y, width) {
  const imageHeight = 5.5;
  const validPhotos = warehouse.validPhotos || [];

  // Add section header - aligned with image content
  slide.addText('Warehouse Image', {
    x: x - 0.05,
    y: y,
    w: width,
    h: 0.3,
    fontFace: 'Verdana',
    fontSize: 12,
    bold: true,
    color: '1F4788'
  });

  y += 0.35;

  // If there are valid photos, use the first one
  if (validPhotos.length > 0) {
    try {
      const imageUrl = validPhotos[0];

      // Download image
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      // Convert to base64 data URL, normalising EXIF orientation (phone uploads)
      // since PPT renderers ignore the EXIF tag and would show rotated photos sideways.
      const { data: base64Image } = await normalizeImageBuffer(Buffer.from(response.data), imageUrl);

      // Add image to slide
      slide.addImage({
        data: base64Image,
        x: x,
        y: y,
        w: width,
        h: imageHeight,
        sizing: { type: 'contain', w: width, h: imageHeight }
      });

    } catch (error) {
      // Display placeholder if image fails to load
      logError('detailedSlide', 'renderWarehouseImage', 'Failed to download warehouse image', {
        warehouseId: warehouse.id,
        url: validPhotos[0],
        error: error.message
      });

      slide.addShape(pptx.shapes.RECTANGLE, {
        x: x,
        y: y,
        w: width,
        h: imageHeight,
        fill: { color: 'F5F5F5' },
        line: { color: 'DDDDDD', width: 1 }
      });

      slide.addText('Failed to load image', {
        x: x,
        y: y + (imageHeight / 2) - 0.25,
        w: width,
        h: 0.5,
        align: 'center',
        valign: 'middle',
        fontSize: 11,
        color: 'AAAAAA'
      });
    }
  } else {
    // No photos available - show placeholder
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: x,
      y: y,
      w: width,
      h: imageHeight,
      fill: { color: 'F5F5F5' },
      line: { color: 'DDDDDD', width: 1 }
    });

    slide.addText('No image available', {
      x: x,
      y: y + (imageHeight / 2) - 0.25,
      w: width,
      h: 0.5,
      align: 'center',
      valign: 'middle',
      fontSize: 11,
      color: 'AAAAAA'
    });
  }
}

/**
 * Render satellite image on the right side of the slide
 * Uses pre-downloaded Mapbox satellite image buffer
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} slide - Slide object
 * @param {Object} warehouse - Warehouse object
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Image width
 */
async function renderSatelliteImage(pptx, slide, warehouse, x, y, width) {
  const geospatial = warehouse.geospatial || {};
  const satelliteImage = geospatial.satelliteImage; // { imageBuffer, contentType }
  const imageHeight = 5.5; // Larger image for location slide

  // Add section header - aligned with image content
  slide.addText('Satellite View', {
    x: x - 0.05,
    y: y,
    w: width,
    h: 0.3,
    fontFace: 'Verdana',
    fontSize: 12,
    bold: true,
    color: '1F4788'
  });

  y += 0.35;

  if (!satelliteImage || !satelliteImage.imageBuffer) {
    // Display placeholder rectangle if no image available
    slide.addShape(pptx.shapes.RECTANGLE, {
      x: x,
      y: y,
      w: width,
      h: imageHeight,
      fill: { color: 'E8E8E8' }
    });

    slide.addText('Satellite image not available', {
      x: x,
      y: y + (imageHeight / 2) - 0.25,
      w: width,
      h: 0.5,
      align: 'center',
      valign: 'middle',
      fontSize: 11,
      color: '999999'
    });

    logWarn('detailedSlide', 'renderSatelliteImage', 'No satellite image for warehouse', {
      warehouseId: warehouse.id,
      latitude: geospatial.latitude,
      longitude: geospatial.longitude
    });
    return;
  }

  try {
    // Convert pre-downloaded buffer to base64 data URL
    const contentType = satelliteImage.contentType || 'image/jpeg';
    const base64Image = `data:${contentType};base64,${satelliteImage.imageBuffer.toString('base64')}`;

    // Embed image with appropriate sizing
    // Mapbox already includes a red pin marker, so no manual overlay needed
    slide.addImage({
      data: base64Image,
      x: x,
      y: y,
      w: width,
      h: imageHeight,
      sizing: { type: 'contain', w: width, h: imageHeight }
    });

  } catch (error) {
    // Display placeholder rectangle if image embedding fails
    logError('detailedSlide', 'renderSatelliteImage', 'Failed to embed satellite image', {
      warehouseId: warehouse.id,
      error: error.message
    });

    slide.addShape(pptx.shapes.RECTANGLE, {
      x: x,
      y: y,
      w: width,
      h: imageHeight,
      fill: { color: 'E8E8E8' }
    });

    slide.addText('Failed to load satellite image', {
      x: x,
      y: y + (imageHeight / 2) - 0.25,
      w: width,
      h: 0.5,
      align: 'center',
      valign: 'middle',
      fontSize: 11,
      color: '999999'
    });
  }
}

/**
 * Generate photo slides for a warehouse with dynamic layouts
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} warehouse - Enriched warehouse object with validPhotos array
 * @param {number} optionIndex - Option number for this warehouse
 */
async function generatePhotoSlides(pptx, warehouse, optionIndex) {
  const photoUrls = warehouse.validPhotos || [];

  if (photoUrls.length === 0) {
    return;
  }

  // Group photos into batches of 4
  const batches = [];
  for (let i = 0; i < photoUrls.length; i += 4) {
    batches.push(photoUrls.slice(i, i + 4));
  }

  const totalPages = batches.length;

  // Create slides for each batch
  for (let pageIndex = 0; pageIndex < batches.length; pageIndex++) {
    const batch = batches[pageIndex];
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };

    // Add slide header: "Warehouse #X - Photos (Page Y of Z)"
    const header = `Warehouse #${warehouse.id} - Photos (Page ${pageIndex + 1} of ${totalPages})`;
    slide.addText(header, {
      x: 0.5,
      y: 0.3,
      w: 12.33,
      h: 0.5,
      fontFace: 'Verdana',
      fontSize: 16,
      bold: true,
      align: 'center',
      color: '000000'
    });

    // Determine layout based on batch size and render images
    await renderPhotoLayout(pptx, slide, batch, warehouse.id);
  }
}

/**
 * Render photo layout based on number of images
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} slide - Slide object
 * @param {Array} photoUrls - Array of photo URLs (1-4 images)
 * @param {number} warehouseId - Warehouse ID for logging
 */
async function renderPhotoLayout(pptx, slide, photoUrls, warehouseId) {
  const numPhotos = photoUrls.length;

  switch (numPhotos) {
    case 1:
      await renderSingleImageLayout(pptx, slide, photoUrls, warehouseId);
      break;
    case 2:
      await renderTwoImageLayout(pptx, slide, photoUrls, warehouseId);
      break;
    case 3:
      await renderThreeImageLayout(pptx, slide, photoUrls, warehouseId);
      break;
    case 4:
      await renderFourImageLayout(pptx, slide, photoUrls, warehouseId);
      break;
    default:
      logWarn('detailedSlide', 'renderPhotoLayout', 'Unexpected number of photos in batch', {
        warehouseId,
        numPhotos
      });
  }
}

/**
 * Render single image layout - large centered image
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} slide - Slide object
 * @param {Array} photoUrls - Array with 1 photo URL
 * @param {number} warehouseId - Warehouse ID for logging
 */
async function renderSingleImageLayout(pptx, slide, photoUrls, warehouseId) {
  const imageWidth = 7.0;
  const imageHeight = 5.5;
  const x = (13.33 - imageWidth) / 2; // Center horizontally
  const y = (7.5 - imageHeight) / 2 + 0.3; // Center vertically (accounting for header)

  await addImageToSlide(pptx, slide, photoUrls[0], {
    x: x,
    y: y,
    w: imageWidth,
    h: imageHeight,
    sizing: { type: 'contain', w: imageWidth, h: imageHeight }
  }, warehouseId);
}

/**
 * Render two-image layout - side by side
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} slide - Slide object
 * @param {Array} photoUrls - Array with 2 photo URLs
 * @param {number} warehouseId - Warehouse ID for logging
 */
async function renderTwoImageLayout(pptx, slide, photoUrls, warehouseId) {
  const imageWidth = 4.0;
  const imageHeight = 5.0;
  const padding = 0.2;

  const totalWidth = (imageWidth * 2) + padding;
  const startX = (13.33 - totalWidth) / 2;
  const startY = (7.5 - imageHeight) / 2 + 0.3;

  await addImageToSlide(pptx, slide, photoUrls[0], {
    x: startX,
    y: startY,
    w: imageWidth,
    h: imageHeight,
    sizing: { type: 'contain', w: imageWidth, h: imageHeight }
  }, warehouseId);

  await addImageToSlide(pptx, slide, photoUrls[1], {
    x: startX + imageWidth + padding,
    y: startY,
    w: imageWidth,
    h: imageHeight,
    sizing: { type: 'contain', w: imageWidth, h: imageHeight }
  }, warehouseId);
}

/**
 * Render three-image layout - one large top, two smaller bottom
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} slide - Slide object
 * @param {Array} photoUrls - Array with 3 photo URLs
 * @param {number} warehouseId - Warehouse ID for logging
 */
async function renderThreeImageLayout(pptx, slide, photoUrls, warehouseId) {
  const topImageWidth = 6.0;
  const topImageHeight = 3.5;
  const bottomImageWidth = 2.9;
  const bottomImageHeight = 2.0;
  const padding = 0.2;

  const startX = (13.33 - topImageWidth) / 2;
  const startY = 1.2;

  // Top image
  await addImageToSlide(pptx, slide, photoUrls[0], {
    x: startX,
    y: startY,
    w: topImageWidth,
    h: topImageHeight,
    sizing: { type: 'contain', w: topImageWidth, h: topImageHeight }
  }, warehouseId);

  // Bottom left image
  await addImageToSlide(pptx, slide, photoUrls[1], {
    x: startX,
    y: startY + topImageHeight + padding,
    w: bottomImageWidth,
    h: bottomImageHeight,
    sizing: { type: 'contain', w: bottomImageWidth, h: bottomImageHeight }
  }, warehouseId);

  // Bottom right image
  await addImageToSlide(pptx, slide, photoUrls[2], {
    x: startX + bottomImageWidth + padding,
    y: startY + topImageHeight + padding,
    w: bottomImageWidth,
    h: bottomImageHeight,
    sizing: { type: 'contain', w: bottomImageWidth, h: bottomImageHeight }
  }, warehouseId);
}

/**
 * Render four-image layout - 2x2 grid
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} slide - Slide object
 * @param {Array} photoUrls - Array with 4 photo URLs
 * @param {number} warehouseId - Warehouse ID for logging
 */
async function renderFourImageLayout(pptx, slide, photoUrls, warehouseId) {
  const imageWidth = 4.0;
  const imageHeight = 2.8;
  const padding = 0.2;

  const totalWidth = (imageWidth * 2) + padding;
  const totalHeight = (imageHeight * 2) + padding;
  const startX = (13.33 - totalWidth) / 2;
  const startY = (7.5 - totalHeight) / 2 + 0.3;

  const positions = [
    { x: startX, y: startY }, // Top left
    { x: startX + imageWidth + padding, y: startY }, // Top right
    { x: startX, y: startY + imageHeight + padding }, // Bottom left
    { x: startX + imageWidth + padding, y: startY + imageHeight + padding } // Bottom right
  ];

  for (let i = 0; i < 4; i++) {
    await addImageToSlide(pptx, slide, photoUrls[i], {
      x: positions[i].x,
      y: positions[i].y,
      w: imageWidth,
      h: imageHeight,
      sizing: { type: 'contain', w: imageWidth, h: imageHeight }
    }, warehouseId);
  }
}

/**
 * Helper function to add an image to a slide with error handling
 * @param {Object} pptx - PptxGenJS instance
 * @param {Object} slide - Slide object
 * @param {string} url - Image URL
 * @param {Object} options - Image options (x, y, w, h, sizing)
 * @param {number} warehouseId - Warehouse ID for logging
 */
async function addImageToSlide(pptx, slide, url, options, warehouseId) {
  try {
    // Download image
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000
    });

    // Convert to base64 data URL, normalising EXIF orientation (phone uploads)
    // since PPT renderers ignore the EXIF tag and would show rotated photos sideways.
    const { data: base64Image } = await normalizeImageBuffer(Buffer.from(response.data), url);

    // Add image to slide
    slide.addImage({
      data: base64Image,
      ...options
    });

  } catch (error) {
    // Display gray placeholder rectangle for failed downloads
    logError('detailedSlide', 'addImageToSlide', 'Failed to download image', {
      warehouseId,
      url,
      error: error.message
    });

    slide.addShape(pptx.shapes.RECTANGLE, {
      x: options.x,
      y: options.y,
      w: options.w,
      h: options.h,
      fill: { color: 'E0E0E0' }
    });
  }
}

module.exports = {
  generateDetailedSlide,
  generatePhotoSlides
};
