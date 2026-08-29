/**
 * The data model (SPEC §3) lands here in build-order step 2. The skeleton
 * carries the module so the two database clients can already be typed against
 * it, and so that `pnpm typecheck` proves the wiring before there is a table to
 * read.
 */
export {};
