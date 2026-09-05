/**
 * Logo manifest reconciliation — the pure half of fetch-logos.mjs.
 *
 * The manifest (config/logos.json) is TRACKED; the image files are not (a
 * build artifact, see .gitignore). On 2026-08-28 a fresh hume clone ran the
 * logo step, five vendors' favicons were refused by bot walls (LinkedIn,
 * NetSuite, OpenAI, SendGrid, Tableau), and the manifest was regenerated from
 * whatever was on disk — without them. The deploy shipped it, and the live
 * board lost five logos until the files were restored from another clone.
 *
 * Rule: a refused download must never shrink the manifest. An entry leaves
 * the manifest only when its vendor leaves config. A vendor still in config
 * whose logo the manifest lists but this clone cannot serve is an ERROR to
 * stop on, not a silent downgrade — restore the asset from a clone that has
 * it (README, Troubleshooting) or declare `iconUrl`.
 *
 * @param {Record<string,string>} previous the committed manifest (slug -> file)
 * @param {string[]} onDisk files present in assets/icons
 * @param {string[]} configuredSlugs slugs of every vendor currently in config
 * @returns {{manifest: Record<string,string>, missing: string[], pruned: string[]}}
 *   manifest: what to write; missing: configured slugs the manifest lists but
 *   no file backs (fail the build); pruned: entries dropped because their
 *   vendor left config.
 */
export function reconcileManifest(previous, onDisk, configuredSlugs) {
  const files = new Set(onDisk.filter((f) => !f.startsWith('.')));
  const configured = new Set(configuredSlugs);
  const manifest = {};
  const missing = [];
  const pruned = [];

  // Everything on disk for a configured vendor is served.
  for (const f of [...files].sort()) {
    const slug = f.replace(/\.[^.]+$/, '');
    if (configured.has(slug)) manifest[slug] = f;
  }
  // A committed entry with no file: keep it only if the vendor is still
  // configured, and flag it — a refused download is not vendor removal.
  for (const [slug, file] of Object.entries(previous ?? {})) {
    if (!configured.has(slug)) {
      if (!manifest[slug]) pruned.push(slug);
      continue;
    }
    if (!manifest[slug]) {
      manifest[slug] = file;
      missing.push(slug);
    }
  }
  return { manifest: Object.fromEntries(Object.entries(manifest).sort()), missing, pruned };
}
