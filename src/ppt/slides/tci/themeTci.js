const path = require('path');

const COLORS = {
    text: '1D1712',          // body text (sampled from source)
    textInverse: 'FFFFFF',
    headerBg: '242739',      // dark navy of the table's "Project name" header
    rule: '9B9FA9',          // grey divider rules under the title
    border: '000000',        // table borders are solid black in the source
    brandYellow: 'FCB034',
    bg: 'FFFFFF',
    hyperlink: '0563C1',
};

// Option-slide content box. Every element below the title — the grey rules, the
// spec table, the photo grid — is laid out against this, so the slide reads as
// one column with equal left/right margins.
//
// The traced rules were very slightly asymmetric (0.17 in from the left, 0.28
// from the right); they now use MARGIN like everything else.
const LAYOUT = {
    SLIDE_W: 10,
    SLIDE_H: 7.5,
    MARGIN: 0.20,
    /** Top of the content area, just below the rules. */
    CONTENT_TOP: 1.30,
    /** Bottom of the content area. */
    CONTENT_BOTTOM: 7.10,
};
LAYOUT.CONTENT_W = LAYOUT.SLIDE_W - 2 * LAYOUT.MARGIN;
LAYOUT.CONTENT_H = LAYOUT.CONTENT_BOTTOM - LAYOUT.CONTENT_TOP;

const FONT = 'Calibri';
const FONT_BOLD = 'Calibri';

const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const TCI_LOGO_PATH = path.join(ASSETS_DIR, 'tci_logo.png');
const TCI_BACKDROP_PATH = path.join(ASSETS_DIR, 'tci_backdrop.jpg');
const TCI_THANK_YOU_PATH = path.join(ASSETS_DIR, 'tci_thank_you.png');

const formatDate = (d = new Date()) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
};

module.exports = {
    COLORS,
    LAYOUT,
    FONT,
    FONT_BOLD,
    TCI_LOGO_PATH,
    TCI_BACKDROP_PATH,
    TCI_THANK_YOU_PATH,
    formatDate,
};
