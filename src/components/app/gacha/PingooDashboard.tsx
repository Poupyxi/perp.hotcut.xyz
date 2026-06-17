import { useEffect, useState } from "react";
import {
  clonePackConfig,
  DEFAULT_PACKS,
  formatSol,
  loadDraftConfig,
  loadPackConfig,
  publishToGame,
  saveDraftConfig,
  TIER_META,
  type Pack,
} from "./PingooMachine";
import "@/styles/pingoo.css";

type Props = {
  onBack?: () => void;
};

export function PingooDashboard({ onBack }: Props) {
  // Draft: edited locally in the Control Panel, does not affect the public game.
  const [draft, setDraft] = useState<Pack[]>(loadDraftConfig);
  // Active: the configuration currently used by game.hotcut.xyz.
  const [activeConfig, setActiveConfig] = useState<Pack[]>(loadPackConfig);
  const [feedback, setFeedback] = useState("");
  const [publishedAt, setPublishedAt] = useState<string | null>(null);

  // Keep activeConfig in sync when the component mounts (e.g., after a publish).
  useEffect(() => {
    setActiveConfig(loadPackConfig());
  }, []);

  function updateOdds(packIndex: number, tierKey: string, value: string) {
    setDraft((current) =>
      current.map((item, index) =>
        index === packIndex ? { ...item, odds: { ...item.odds, [tierKey]: Number(value) } } : item,
      ),
    );
  }

  function updateRange(packIndex: number, tierKey: string, rangeIndex: number, value: string) {
    setDraft((current) =>
      current.map((item, index) => {
        if (index !== packIndex) return item;
        const nextRange = [...(item.ranges[tierKey as keyof typeof item.ranges] as [number, number])];
        nextRange[rangeIndex] = Number(value);
        return { ...item, ranges: { ...item.ranges, [tierKey]: nextRange } };
      }),
    );
  }

  function validate(config: Pack[]): string {
    for (const item of config) {
      const total = TIER_META.reduce((sum, tier) => sum + Number(item.odds[tier.key as keyof typeof item.odds] || 0), 0);
      if (Math.abs(total - 100) > 0.0001) return `Le pack ${formatSol(item.price)} totalise ${total}% au lieu de 100%.`;
      for (const tier of TIER_META) {
        const [min, max] = item.ranges[tier.key as keyof typeof item.ranges] as [number, number];
        if (!Number.isFinite(min) || !Number.isFinite(max)) return `La fourchette ${tier.label} du pack ${formatSol(item.price)} est invalide.`;
        if (min > max) return `Le minimum ${tier.label} du pack ${formatSol(item.price)} dépasse le maximum.`;
        if (min < -100) return "Une valeur inférieure à -100% produirait une carte à valeur négative.";
      }
    }
    return "";
  }

  /** Save draft locally — does NOT affect the public game. */
  function handleSaveDraft() {
    const error = validate(draft);
    if (error) { setFeedback(error); return; }
    saveDraftConfig(clonePackConfig(draft));
    setFeedback("Brouillon enregistré. Utilisez « Publier vers le jeu » pour mettre à jour la configuration active.");
  }

  /** Publish draft → active: updates game.hotcut.xyz configuration. */
  function handlePublish() {
    const error = validate(draft);
    if (error) { setFeedback(error); return; }
    const publishError = publishToGame(clonePackConfig(draft));
    if (publishError) { setFeedback(`Erreur de publication : ${publishError}`); return; }
    saveDraftConfig(clonePackConfig(draft));
    setActiveConfig(clonePackConfig(draft));
    const now = new Date().toLocaleString("fr-FR");
    setPublishedAt(now);
    setFeedback(`✓ Configuration publiée vers le jeu à ${now}.`);
  }

  /** Reset draft and active to factory defaults. */
  function handleReset() {
    const reset = clonePackConfig(DEFAULT_PACKS);
    setDraft(reset);
    saveDraftConfig(reset);
    setFeedback("Brouillon réinitialisé aux valeurs d'origine. Cliquez sur « Publier » pour appliquer au jeu.");
  }

  const draftMatchesActive = JSON.stringify(draft) === JSON.stringify(activeConfig);

  return (
    <div className="dashboard-shell">
      <header className="dashboard-topbar">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div><strong>PINGOO</strong><span>CONTROL ROOM</span></div>
        </div>
        <div className="dashboard-top-actions">
          <span className="dashboard-devnet-pill">SOLANA DEVNET</span>
          {onBack && <button type="button" className="dashboard-back-button" onClick={onBack}>← Retour à la machine</button>}
        </div>
      </header>

      <main className="dashboard-content">
        <section className="dashboard-hero">
          <span className="eyebrow">DASHBOARD</span>
          <h1>Contrôle des ratios et de la luck</h1>
          <p>
            Chaque booster possède ses propres chances de tirage et ses propres fourchettes de variation par rapport à son prix de base.
            Exemple : un pack à 5 SOL avec <strong>+30%</strong> révèle une valeur simulée de <strong>6.5 SOL</strong>.
          </p>
        </section>

        {/* Config status banner */}
        <section className="dashboard-rules-card">
          <div>
            <strong>Brouillon (Training Luck)</strong>
            <span>Éditable ici. N'affecte pas le jeu public tant que vous ne publiez pas.</span>
          </div>
          <div>
            <strong>Configuration active (game.hotcut.xyz)</strong>
            <span>
              {publishedAt
                ? `Dernière publication : ${publishedAt}`
                : draftMatchesActive
                  ? "Synchronisée avec le brouillon."
                  : "Brouillon non publié — le jeu utilise la configuration précédente."}
            </span>
          </div>
          <div>
            <strong>Validation</strong>
            <span>La somme des 5 ratios doit être exactement égale à 100% pour chaque booster.</span>
          </div>
        </section>

        <div className="dashboard-pack-list">
          {draft.map((item, packIndex) => {
            const total = TIER_META.reduce((sum, tier) => sum + Number(item.odds[tier.key as keyof typeof item.odds] || 0), 0);
            const validTotal = Math.abs(total - 100) < 0.0001;
            return (
              <section className="dashboard-pack-card" key={item.id}>
                <div className="dashboard-pack-heading">
                  <div className="dashboard-pack-name">
                    <span className="dashboard-pack-swatch" style={{ "--pack-gradient": item.gradient } as React.CSSProperties} />
                    <div><span>BOOSTER</span><strong>{formatSol(item.price)}</strong></div>
                  </div>
                  <div className={`dashboard-total ${validTotal ? "valid" : "invalid"}`}>
                    <span>Total des chances</span><strong>{total}%</strong>
                  </div>
                </div>
                <div className="dashboard-tier-grid">
                  {TIER_META.map((tier) => {
                    const [min, max] = item.ranges[tier.key as keyof typeof item.ranges] as [number, number];
                    const minValue = Math.max(0, item.price * (1 + min / 100));
                    const maxValue = Math.max(0, item.price * (1 + max / 100));
                    return (
                      <article className={`dashboard-tier-card ${tier.key}`} key={tier.key}>
                        <h3>{tier.label}</h3>
                        <label>
                          <span>Chance</span>
                          <div className="dashboard-input-with-unit">
                            <input type="number" min="0" max="100" step="0.1" value={item.odds[tier.key as keyof typeof item.odds]} onChange={(e) => updateOdds(packIndex, tier.key, e.target.value)} />
                            <b>%</b>
                          </div>
                        </label>
                        <div className="dashboard-range-row">
                          <label>
                            <span>Luck min</span>
                            <div className="dashboard-input-with-unit">
                              <input type="number" step="1" value={min} onChange={(e) => updateRange(packIndex, tier.key, 0, e.target.value)} />
                              <b>%</b>
                            </div>
                          </label>
                          <label>
                            <span>Luck max</span>
                            <div className="dashboard-input-with-unit">
                              <input type="number" step="1" value={max} onChange={(e) => updateRange(packIndex, tier.key, 1, e.target.value)} />
                              <b>%</b>
                            </div>
                          </label>
                        </div>
                        <div className="dashboard-value-preview">
                          <span>Valeur simulée</span>
                          <strong>{formatSol(minValue)} → {formatSol(maxValue)}</strong>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        <div className="dashboard-savebar">
          <div>
            <strong>{draftMatchesActive ? "Brouillon synchronisé" : "Brouillon non publié"}</strong>
            <span>{feedback || "Enregistrez le brouillon pour le Training Luck, ou publiez pour mettre à jour le jeu."}</span>
          </div>
          <div className="dashboard-save-actions">
            <button type="button" className="dashboard-reset-button" onClick={handleReset}>Réinitialiser</button>
            <button type="button" className="dashboard-reset-button" onClick={handleSaveDraft}>Enregistrer brouillon</button>
            <button
              type="button"
              className="dashboard-save-button"
              onClick={handlePublish}
              title="Copie le brouillon dans la configuration active lue par game.hotcut.xyz"
            >
              Publier vers le jeu ↗
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
