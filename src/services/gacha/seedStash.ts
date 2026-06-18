// In-memory stash of server seeds. Kept here so the draw row only stores the
// seed after the player has paid (reveal moment). Cleared on accept/refuse.
//
// MVP only. In prod, replace with Redis + TTL so multi-instance deployments
// don't break the commit-reveal flow.

const SEED_TTL_MS = 15 * 60_000;
const stash = new Map<string, { seed: string; expiresAt: number }>();

export function stashServerSeed(drawId: string, seed: string): void {
  stash.set(drawId, { seed, expiresAt: Date.now() + SEED_TTL_MS });
  pruneExpired();
}

export function consumeServerSeed(drawId: string): string | null {
  const entry = stash.get(drawId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    stash.delete(drawId);
    return null;
  }
  return entry.seed;
}

export function dropServerSeed(drawId: string): void {
  stash.delete(drawId);
}

function pruneExpired() {
  if (stash.size < 100) return;
  const now = Date.now();
  for (const [id, entry] of stash) {
    if (entry.expiresAt < now) stash.delete(id);
  }
}
