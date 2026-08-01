/**
 * Split the vendor list across several collection runs.
 *
 * WHY THIS EXISTS. The Workers *free* plan caps a single invocation at 50
 * EXTERNAL subrequests, and that ceiling cannot be raised by configuration —
 * `limits.subrequests` is paid-plan only. Measured on 2026-07-31, one full run
 * cost 47: 41 vendors, plus 3 second-calls (Concur's banner, Google's product
 * catalogue, Perplexity's components), plus 3 redirect chains (Zoom, Calendly,
 * Anthropic), which also count. Three retries anywhere put the run over 50 and
 * the runtime killed every remaining fetch with "Too many subrequests by single
 * Worker invocation" — so 17 vendors reported `unknown` while being perfectly
 * healthy. It was intermittent precisely because it depended on how many
 * retries a given run happened to need.
 *
 * Sharding trades one big run for several small ones. With SHARD_COUNT=3 on a
 * 5-minute cron, each invocation checks ~14 vendors (~16 subrequests, a third
 * of the ceiling) and every vendor is still refreshed exactly once per 15
 * minutes — the interval the page promises is unchanged.
 *
 * Membership is derived from the vendor's NAME, not its position in the config
 * array. Position would reshuffle every shard whenever a vendor is added or
 * removed, so a config edit would scatter rows across shards and briefly skew
 * refresh timing. A name hash keeps an existing vendor in its shard when its
 * neighbours change.
 */

/**
 * Number of shards one full cycle is split into.
 *
 * RAISED 3 -> 15 on 2026-08-01 after every cron began failing with
 * `exceededResources` at cpuP99 = 10,000 us -- exactly the free plan's 10 ms
 * CPU ceiling. The subrequest ceiling was never the binding constraint here;
 * CPU was. Oracle (3.17 ms), IBM (2.29 ms) and AWS (~3.7 ms with its
 * catalogue) parse multi-megabyte documents, and three of them in one
 * invocation exceeds the budget on their own.
 *
 * With a 1-minute cron and 15 shards, each invocation handles ~3 vendors and
 * every vendor is still refreshed once per 15 minutes -- the interval the page
 * promises is unchanged, for the second time.
 */
export const SHARD_COUNT = 15;

/**
 * FNV-1a, 32-bit. Chosen for being tiny and dependency-free against a 10 ms CPU
 * budget; this is a bucketing function, not a security primitive.
 *
 * @param {string} text
 * @returns {number} unsigned 32-bit hash
 */
export function hashName(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    // Multiply by the FNV prime (16777619) using shifts, staying in 32 bits.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Which shard a vendor belongs to.
 *
 * @param {string} name
 * @param {number} [count]
 * @returns {number} 0 <= shard < count
 */
export function shardOf(name, count = SHARD_COUNT) {
  return hashName(String(name)) % count;
}

/**
 * The vendors due to be collected in a given shard.
 *
 * @param {{name: string}[]} vendors
 * @param {number} index
 * @param {number} [count]
 * @returns {{name: string}[]}
 */
export function selectShard(vendors, index, count = SHARD_COUNT) {
  if (!Array.isArray(vendors)) throw new Error('selectShard: vendors must be an array');
  if (!Number.isInteger(count) || count < 1) throw new Error('selectShard: count must be >= 1');
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`selectShard: index must be 0..${count - 1}`);
  }
  return vendors.filter((v) => shardOf(v?.name ?? '', count) === index);
}

/**
 * Which shard is due at a given time.
 *
 * Derived from the clock rather than from stored state so it stays correct
 * across restarts, redeploys and missed crons — there is no counter to drift.
 * With a 5-minute cron and 3 shards this cycles 0,1,2 every 15 minutes.
 *
 * Counted from the EPOCH, not from midnight. A time-of-day slot number resets
 * every 24 h, and the rotation only survives that reset when the slots-per-day
 * divides evenly by `count`: at 5-minute intervals there are 288 slots, and
 * 288 % 3 === 0, so three shards happen to be safe. Five or seven are not —
 * one shard would be skipped at every midnight, roughly 0.3% of its runs,
 * which is exactly the kind of drip-failure nobody attributes to the clock.
 * Since `subrequest_headroom_low` explicitly advises raising SHARD_COUNT, that
 * trap had to be removed rather than documented.
 *
 * @param {Date} at
 * @param {number} [count]
 * @param {number} [everyMinutes] cron interval
 * @returns {number}
 */
export function shardDueAt(at, count = SHARD_COUNT, everyMinutes = 5) {
  const slot = Math.floor(at.getTime() / (everyMinutes * 60_000));
  return ((slot % count) + count) % count; // normalise for pre-epoch dates
}
