# Gacha — Compliance TODO

**Cette page (`/gacha`) est un MVP de test sur Solana DEVNET. Aucun argent réel ne circule. Aucune carte NFT du marché secondaire n'est achetée.**

Avant tout lancement en argent réel (mainnet, SOL ou fiat) :

## 1. Licence et juridiction
- [ ] Revue juridique complète : un mécanisme de loot box / gacha avec valeur de marché et remboursement partiel est très probablement qualifié de **jeu d'argent** dans la majorité des juridictions (France, UE, US, UK, etc.).
- [ ] Obtenir la licence appropriée (en France : ANJ). Sans licence, l'opération est illégale.
- [ ] Avocat spécialisé i-gaming pour rédiger les CGU et la politique de remboursement.

## 2. Conformité technique
- [ ] Remplacer le RNG `crypto.randomBytes` côté serveur par un **VRF on-chain** vérifiable (Switchboard VRF ou Pyth Entropy). Le commit-reveal actuel est un palliatif transparent mais n'est pas un VRF auditable.
- [ ] Audit indépendant des probabilités (`config/gacha-odds.json`).
- [ ] Audit de sécurité de la `SERVER_WALLET_SECRET` : passage en HSM / KMS (Turnkey, Fireblocks, AWS KMS). **Ne jamais laisser une clé chaude en .env en prod.**

## 3. Trésorerie
- [ ] Garantir une réserve de SOL/USD suffisante pour absorber le pire scénario : N jackpots consécutifs. Modèle = `réserve_min = N × valueMax(jackpot) × buffer(1.5)`.
- [ ] Alerting on-chain : seuil bas → suspension automatique des tirages.

## 4. Géo / KYC / âge
- [ ] Remplacer `isAllowedRegion()` (actuellement `return true`) par un vrai filtre GeoIP (MaxMind / Cloudflare headers).
- [ ] Liste de pays bloqués (US sauf NJ/MI, France si pas d'ANJ, etc.).
- [ ] KYC effectif (pas juste un cookie 18+) : provider type Sumsub ou Veriff dès qu'on est en argent réel.
- [ ] Limites de mise (responsible gambling) : limite par session, cooldown obligatoire, lien vers ressources d'aide.

## 5. Comptabilité et lutte anti-blanchiment
- [ ] Conservation des journaux de tirages ≥ 5 ans.
- [ ] Reporting AML / TRACFIN dès qu'on dépasse certains seuils.
- [ ] Audit trail signé cryptographiquement pour chaque draw + chaque payout.

## 6. Code à durcir avant prod
- [ ] Rate-limit IP + wallet (pas juste in-memory — Redis).
- [ ] Vérification on-chain du paiement (slot finality, pas juste `confirmed`).
- [ ] Idempotence des branches Accept / Refuse (pas de double-mint, pas de double-refund).
- [ ] Tests d'intégration end-to-end avec un wallet de test.

---

**Statut actuel : DEVNET uniquement, à des fins de prototypage technique. Aucun de ces points n'est requis pour le MVP, mais ils doivent tous être traités avant tout passage en argent réel.**
