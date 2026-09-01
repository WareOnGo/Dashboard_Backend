const path = require('path');

const COLORS = {
    navy: '1A3350',
    navyDark: '1E3148',
    /**
     * A desaturated navy for supporting text — a landmark's name beside its
     * category, a drive time beside a distance. Same family as `navy` so it does
     * not read as a second colour, light enough to recede rather than compete.
     */
    navyMuted: '76839A',
    accentBlue: '0077CC',
    sidebar: 'F8F6F1',
    divider: 'CCCCCC',
    bg: 'F8F6F1',
    black: '000000',
};

const FONT = 'Montserrat';

const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'WOG_logo_Transparent.png');
const COVER_HERO_PATH = path.join(__dirname, '..', '..', 'assets', 'cover-hero.jpg');

const formatDate = (d = new Date()) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

module.exports = { COLORS, FONT, LOGO_PATH, COVER_HERO_PATH, formatDate };
