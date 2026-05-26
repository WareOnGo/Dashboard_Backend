const parseAdminEmails = () =>
    (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

const isAdmin = (email) => {
    if (!email || typeof email !== 'string') return false;
    return parseAdminEmails().includes(email.toLowerCase());
};

module.exports = { isAdmin };
