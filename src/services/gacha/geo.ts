// MVP devnet: zero region check.
// TODO: replace with real GeoIP (Cloudflare CF-IPCountry header, or MaxMind).
// Block jurisdictions where loot-box mechanics require a gambling license unless
// the operator holds one (FR -> ANJ, US except NJ/MI, UK, etc.).

export function isAllowedRegion(_request: Request): boolean {
  return true;
}

export function blockedRegionMessage(): string {
  return "Cette version de test n'est pas accessible depuis ta région. Reviens depuis une zone autorisée.";
}
