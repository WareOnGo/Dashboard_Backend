/** Short-lived lookups with one shared promise per key and safe invalidation. */
class LookupCache {
    constructor(ttlMs, cacheable = () => true) {
        this.ttlMs = ttlMs;
        this.cacheable = cacheable;
        this.values = new Map();
        this.pending = new Map();
    }

    async get(key, lookup) {
        const hit = this.values.get(key);
        if (hit && hit.expiresAt > Date.now()) return hit.value;
        this.values.delete(key);

        let task = this.pending.get(key);
        if (!task) {
            task = { invalidated: false };
            task.promise = Promise.resolve().then(lookup).then(value => {
                // A roster update can invalidate a lookup while it is awaiting the
                // database. Never let the old result restore revoked access.
                if (!task.invalidated && this.cacheable(value)) {
                    const now = Date.now();
                    for (const [cachedKey, entry] of this.values) {
                        if (entry.expiresAt <= now) this.values.delete(cachedKey);
                    }
                    this.values.set(key, { value, expiresAt: now + this.ttlMs });
                }
                return value;
            }).finally(() => {
                if (this.pending.get(key) === task) this.pending.delete(key);
            });
            this.pending.set(key, task);
        }

        const value = await task.promise;
        return task.invalidated ? this.get(key, lookup) : value;
    }

    clear(key) {
        if (key === undefined) {
            this.values.clear();
            for (const task of this.pending.values()) task.invalidated = true;
            this.pending.clear();
        } else {
            this.values.delete(key);
            const task = this.pending.get(key);
            if (task) task.invalidated = true;
            this.pending.delete(key);
        }
    }
}

module.exports = LookupCache;
