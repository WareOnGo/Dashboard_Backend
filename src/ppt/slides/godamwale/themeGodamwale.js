const path = require('path');

// Black on white with red brand accents. The legacy v2 color keys (navy /
// navyDark / sidebar) are kept so the v2-derived slide code reads unchanged —
// they're just reassigned to the new palette here.
const COLORS = {
    navy: '000000',       // primary text
    navyDark: '000000',   // title cover overlay (rendered with transparency)
    accentBlue: '0077CC', // unused
    sidebar: 'FFFFFF',    // table value cells / left rail
    divider: 'D0D0D0',
    bg: 'FFFFFF',
    black: '000000',
    brandRed: 'D42020',   // accent — matches the GW logo red
};

const FONT = 'Montserrat';

const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const WOG_LOGO_PATH = path.join(ASSETS_DIR, 'WOG_logo_Transparent.png');
const COVER_HERO_PATH = path.join(ASSETS_DIR, 'cover-hero.jpg');
const GODAMWALE_LOGO_PATH = path.join(ASSETS_DIR, 'godamwale_logo.png');
const GODAMWALE_ICON_PATH = path.join(ASSETS_DIR, 'godamwale_icon.png');
const GODAMWALE_BAR_PATH = path.join(ASSETS_DIR, 'godamwale_bottom_bar.png');

const formatDate = (d = new Date()) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

module.exports = {
    COLORS,
    FONT,
    WOG_LOGO_PATH,
    COVER_HERO_PATH,
    GODAMWALE_LOGO_PATH,
    GODAMWALE_ICON_PATH,
    GODAMWALE_BAR_PATH,
    formatDate,
};
