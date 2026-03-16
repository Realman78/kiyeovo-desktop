CACHE
if we were to implement cache, how would we do it?


I’d do a targeted cache, not a blanket one.

Cache only where it helps
Keep versionMetaCache (high value, low risk).
Re-add storeCache only for periodic checks on older epochs.
Do not use store cache for nudge mode or current epoch.
Use read-through cache with strict policy
getLatestStore(bucketKey, { mode, epoch, currentEpoch })
Cache hit allowed only if:
mode === 'periodic'
epoch < currentEpoch - 1
entry not expired
Separate TTLs
versionMetaCache: 30-60 min (metadata is effectively immutable per version).
storeCache: 60-120s (short, to absorb burst checks).
missingCache: 10-20s (only to avoid hammering on no-record/DHT error).
Invalidation rules
On successful putStore: overwrite storeCache[bucketKey], clear missing cache.
On epoch prune/group delete: remove all cache entries for that prefix.
On merge-recovery failure: drop cache for that bucket immediately.
Safety guard
Never let cache skip correctness checks:
signatures and ordering still validated after read.
if suspicious mismatch (version regression, parse fail), bypass cache and refetch DHT.
Add metrics first
Log hit/miss per cache and mode.
If hit rate stays low, remove it again.
If you want, I can sketch the exact getLatestStore signature + minimal code patch shape before implementing.