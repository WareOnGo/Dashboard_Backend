function editorUserId(user) {
    const id = user?.id;
    if (typeof id !== 'string' && !(typeof id === 'number' && Number.isFinite(id))) return null;
    return String(id).trim() || null;
}

/** Resolve attribution from trusted authentication context, never request fields. */
function editorIdentity(user) {
    const email = typeof user?.email === 'string' ? user.email.trim() : '';
    if (email) return email;
    return editorUserId(user);
}

module.exports = { editorIdentity, editorUserId };
