import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type WalletName } from "@solana/wallet-adapter-base";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import "@/styles/pingoo.css";

const TREASURY_ADDRESS =
  (typeof window !== "undefined" && (import.meta as { env?: Record<string, string> }).env?.VITE_TREASURY_ADDRESS) ||
  "5KzPJNwXiSzxNpMbBpMP1JrVVhBGT7CJsGygLhLFFLeW";
const TREASURY_PUBLIC_KEY = new PublicKey(TREASURY_ADDRESS);

const CATEGORIES = [
  { id: "pokemon", name: "Pokémon", subtitle: "Monsters & trainers", icon: "⚡", img: "/IconPOKEMON.png", accent: "#f5c542", soft: "rgba(245,197,66,.24)" },
  { id: "onepiece", name: "One Piece", subtitle: "Pirates & legends", icon: "☠", img: "/IconONEPIECE.png", accent: "#35a7ff", soft: "rgba(53,167,255,.24)" },
  { id: "yugioh", name: "Yu-Gi-Oh!", subtitle: "Duel cards", icon: "✦", img: "/IconYUGIOH.png", accent: "#bd5cff", soft: "rgba(189,92,255,.24)" },
  { id: "sports", name: "Sports", subtitle: "Stars & rookies", icon: "🏆", img: "/IconNBA.png", accent: "#52e79c", soft: "rgba(82,231,156,.22)" },
  // { id: "magic", name: "Magic", subtitle: "Fantasy cards", icon: "🔥", accent: "#ff704f", soft: "rgba(255,112,79,.22)" },
  // { id: "lorcana", name: "Lorcana", subtitle: "Enchanted cards", icon: "🪄", accent: "#ff6fd8", soft: "rgba(255,111,216,.22)" },
  // { id: "dragonball", name: "Dragon Ball", subtitle: "Warriors & energy", icon: "🐉", accent: "#ff9d32", soft: "rgba(255,157,50,.22)" },
  // { id: "other", name: "Other", subtitle: "More collections", icon: "◆", accent: "#8d93ff", soft: "rgba(141,147,255,.22)" },
];

/** Legacy key — migrated to ACTIVE on first load. */
const PACK_CONFIG_LEGACY_KEY = "pingoo-pack-config-v1";
/** Active config — used by the public game. Only updated via "Publish to Game". */
export const ACTIVE_CONFIG_KEY = "pingoo-active-config-v1";
/** Draft config — edited by the Control Panel, never read by the public game. */
export const DRAFT_CONFIG_KEY = "pingoo-draft-config-v2";

export const TIER_META = [
  { key: "jackpot", label: "Jackpot" },
  { key: "win", label: "Win" },
  { key: "breakEven", label: "Break-even" },
  { key: "loss", label: "Loss" },
  { key: "ultraLoss", label: "Ultra loss" },
];

export const DEFAULT_PACKS = [
  {
    id: "tier-01", price: 0.1, badge: "01",
    gradient: "linear-gradient(155deg,#5be7ff,#174ba9 78%)",
    odds: { jackpot: 1, win: 9, breakEven: 50, loss: 30, ultraLoss: 10 },
    ranges: { jackpot: [80, 120], win: [1, 79], breakEven: [0, 0], loss: [-10, -1], ultraLoss: [-20, -11] },
  },
  {
    id: "tier-02", price: 0.2, badge: "02",
    gradient: "linear-gradient(155deg,#6fffb0,#11654a 78%)",
    odds: { jackpot: 1, win: 10, breakEven: 50, loss: 30, ultraLoss: 9 },
    ranges: { jackpot: [80, 120], win: [1, 79], breakEven: [0, 0], loss: [-10, -1], ultraLoss: [-20, -11] },
  },
  {
    id: "tier-05", price: 0.5, badge: "05",
    gradient: "linear-gradient(155deg,#ffd764,#9a5314 78%)",
    odds: { jackpot: 2, win: 11, breakEven: 50, loss: 29, ultraLoss: 8 },
    ranges: { jackpot: [80, 120], win: [1, 79], breakEven: [0, 0], loss: [-10, -1], ultraLoss: [-20, -11] },
  },
  {
    id: "tier-10", price: 1, badge: "10",
    gradient: "linear-gradient(155deg,#ff75bd,#6c1d62 78%)",
    odds: { jackpot: 3, win: 12, breakEven: 50, loss: 28, ultraLoss: 7 },
    ranges: { jackpot: [80, 120], win: [1, 79], breakEven: [0, 0], loss: [-10, -1], ultraLoss: [-20, -11] },
  },
  {
    id: "tier-50", price: 5, badge: "50",
    gradient: "linear-gradient(155deg,#b58cff,#321578 78%)",
    odds: { jackpot: 5, win: 15, breakEven: 50, loss: 25, ultraLoss: 5 },
    ranges: { jackpot: [80, 120], win: [1, 79], breakEven: [0, 0], loss: [-10, -1], ultraLoss: [-20, -11] },
  },
];

export type Pack = typeof DEFAULT_PACKS[0];

export function clonePackConfig(config: Pack[]) {
  return JSON.parse(JSON.stringify(config)) as Pack[];
}

function parseStoredConfig(stored: string | null): Pack[] | null {
  try {
    if (!stored) return null;
    const parsed = JSON.parse(stored) as unknown[];
    if (!Array.isArray(parsed) || parsed.length !== DEFAULT_PACKS.length) return null;
    return DEFAULT_PACKS.map((fallback, index) => {
      const candidate = (parsed[index] || {}) as Partial<Pack>;
      return {
        ...fallback,
        odds: { ...fallback.odds, ...(candidate.odds || {}) },
        ranges: { ...fallback.ranges, ...(candidate.ranges || {}) },
      };
    });
  } catch {
    return null;
  }
}

/** Load the Active config (public game). Falls back to legacy key, then defaults. */
export function loadPackConfig(): Pack[] {
  try {
    const active = parseStoredConfig(window.localStorage.getItem(ACTIVE_CONFIG_KEY));
    if (active) return active;
    // Migrate from legacy key on first load.
    const legacy = parseStoredConfig(window.localStorage.getItem(PACK_CONFIG_LEGACY_KEY));
    if (legacy) {
      window.localStorage.setItem(ACTIVE_CONFIG_KEY, JSON.stringify(legacy));
      return legacy;
    }
    return clonePackConfig(DEFAULT_PACKS);
  } catch {
    return clonePackConfig(DEFAULT_PACKS);
  }
}

/** Save Active config (used by the public game). Only called by "Publish to Game". */
export function savePackConfig(config: Pack[]) {
  window.localStorage.setItem(ACTIVE_CONFIG_KEY, JSON.stringify(config));
}

/** Load the Draft config (Control Panel only). Never read by the public game. */
export function loadDraftConfig(): Pack[] {
  try {
    const draft = parseStoredConfig(window.localStorage.getItem(DRAFT_CONFIG_KEY));
    if (draft) return draft;
    // Seed draft from active so the Control Panel starts with current live config.
    return loadPackConfig();
  } catch {
    return clonePackConfig(DEFAULT_PACKS);
  }
}

/** Save Draft config (Control Panel only). Does not affect the public game. */
export function saveDraftConfig(config: Pack[]) {
  window.localStorage.setItem(DRAFT_CONFIG_KEY, JSON.stringify(config));
}

/**
 * Publish Draft → Active atomically.
 * Returns an error string or "" on success.
 */
export function publishToGame(draft: Pack[]): string {
  try {
    const json = JSON.stringify(draft);
    window.localStorage.setItem(ACTIVE_CONFIG_KEY, json);
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : "Erreur lors de la publication.";
  }
}

const CARD_NAMES: Record<string, string[]> = {
  pokemon: ["Electric Holo", "Flame Evolution", "Forest Guardian"],
  onepiece: ["Red Captain Foil", "Grand Navigator", "Sword Master"],
  yugioh: ["Ancient Dragon", "Arcane Magician", "Steel Guardian"],
  sports: ["Rookie Signature", "Finals Champion", "Hall of Fame"],
  magic: ["Mythic Dragon", "Arcane Planeswalker", "Ancient Relic"],
  lorcana: ["Enchanted Hero", "Legendary Ink", "Royal Foil"],
  dragonball: ["Ultra Warrior", "Fusion Foil", "Energy Leader"],
  other: ["Rare Collectible", "Limited Edition", "Collector Foil"],
};

export function formatSol(value: number) {
  return `${Number(value).toLocaleString("en-US", { maximumFractionDigits: 3 })} SOL`;
}

function formatSignedSol(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const normalized = Math.abs(Number(value)) < 0.00005 ? 0 : Number(value);
  const sign = normalized > 0 ? "+" : "";
  return `${sign}${normalized.toFixed(4)} SOL`;
}

function shortAddress(address: string) {
  if (!address) return "";
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function randomFloat() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] / 2 ** 32;
}

function randomBetween(min: number, max: number) {
  return min + randomFloat() * (max - min);
}

function createMockCard(category: typeof CATEGORIES[0], pack: Pack) {
  const roll = randomFloat() * 100;
  const names = CARD_NAMES[category.id];
  const jackpotLimit = pack.odds.jackpot;
  const winLimit = jackpotLimit + pack.odds.win;
  const breakEvenLimit = winLimit + pack.odds.breakEven;
  const lossLimit = breakEvenLimit + pack.odds.loss;

  let tier = "ultraLoss";
  if (roll < jackpotLimit) tier = "jackpot";
  else if (roll < winLimit) tier = "win";
  else if (roll < breakEvenLimit) tier = "breakEven";
  else if (roll < lossLimit) tier = "loss";

  const [minLuck, maxLuck] = pack.ranges[tier as keyof typeof pack.ranges] as [number, number];
  const luckPercent = Number(randomBetween(minLuck, maxLuck).toFixed(2));
  const value = Number((pack.price * (1 + luckPercent / 100)).toFixed(4));
  const labels: Record<string, string> = { jackpot: "Jackpot", win: "Win", breakEven: "Break-even", loss: "Loss", ultraLoss: "Ultra loss" };
  const name = tier === "jackpot" || tier === "win" ? names[0] : tier === "breakEven" ? names[1] : names[2];
  return { name, set: `${category.name} Collection`, value, rarity: `${labels[tier]} · ${luckPercent >= 0 ? "+" : ""}${luckPercent}%`, tier, luckPercent, art: category.icon };
}

function friendlyTransactionError(error: unknown) {
  const message = (error as Error)?.message || String(error || "Erreur inconnue");
  if (/User rejected|rejected the request|declined/i.test(message)) return "Transaction annulée dans le wallet.";
  if (/insufficient funds|Attempt to debit/i.test(message)) return "Solde Devnet insuffisant pour payer ce booster et les frais réseau.";
  if (/blockhash not found|expired/i.test(message)) return "La transaction a expiré. Relance le paiement.";
  return `Transaction impossible : ${message}`;
}

function useLiveBalance(publicKey: PublicKey | null) {
  const { connection } = useConnection();
  const address = publicKey?.toBase58?.() || null;
  const [balance, setBalance] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!address) { setBalance(null); return null; }
    const lamports = await connection.getBalance(new PublicKey(address), "confirmed");
    const nextBalance = lamports / LAMPORTS_PER_SOL;
    setBalance(nextBalance);
    return nextBalance;
  }, [address, connection]);

  useEffect(() => {
    if (!address) { setBalance(null); return; }
    refresh().catch((error) => console.warn("Balance unavailable:", error));
    const subscriptionId = connection.onAccountChange(
      new PublicKey(address),
      (accountInfo) => setBalance(accountInfo.lamports / LAMPORTS_PER_SOL),
      "confirmed",
    );
    return () => { connection.removeAccountChangeListener(subscriptionId).catch(() => undefined); };
  }, [address, connection, refresh]);

  return { balance, refresh };
}

function WalletTopBarButton({ walletConnectionError, clearWalletConnectionError, onOpenWalletModal, onDisconnect }: {
  walletConnectionError: string;
  clearWalletConnectionError: () => void;
  onOpenWalletModal: () => void;
  onDisconnect: () => void;
}) {
  const { connected, connecting } = useWallet();
  useEffect(() => { if (connected) clearWalletConnectionError(); }, [connected, clearWalletConnectionError]);
  return (
    <div className="topbar-wallet">
      <button type="button" className="wallet-button-custom" onClick={connected ? onDisconnect : onOpenWalletModal} disabled={connecting}>
        {connecting ? "Connexion…" : connected ? "Déconnecter" : "Connect Wallet"}
      </button>
      {walletConnectionError && <small className="wallet-inline-error">{walletConnectionError}</small>}
    </div>
  );
}

function WalletStatus({ balance }: { balance: number | null }) {
  const { connected, publicKey } = useWallet();
  return (
    <div className="wallet-area">
      {connected && publicKey && (
        <div className="wallet-meta">
          <span>{shortAddress(publicKey.toBase58())}</span>
          <small>{balance === null ? "Chargement…" : `${balance.toFixed(3)} SOL · Devnet`}</small>
        </div>
      )}
    </div>
  );
}

function AppModal({ title, eyebrow, onClose, children, className = "" }: {
  title: string; eyebrow?: string; onClose: () => void; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`app-modal-layer ${className}`} role="presentation">
      <button type="button" className="app-modal-backdrop" aria-label="Fermer la fenêtre" onClick={onClose} />
      <section className="app-modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="app-modal-close" onClick={onClose} aria-label="Fermer">×</button>
        {eyebrow && <span className="app-modal-eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  );
}

function WalletConnectModal({ wallets, selectedWalletName, connecting, error, onChoose, onConnect, onClose }: {
  wallets: { adapter: { name: string; icon?: string }; readyState: string }[];
  selectedWalletName: string; connecting: boolean; error: string;
  onChoose: (name: string) => void; onConnect: () => void; onClose: () => void;
}) {
  return (
    <AppModal title="Connect a wallet on Solana to continue" eyebrow="SOLANA DEVNET" onClose={onClose} className="wallet-choice-modal">
      <div className="wallet-choice-list">
        {wallets.map(({ adapter, readyState }) => {
          const isSelected = selectedWalletName === adapter.name;
          const detected = readyState === "Installed" || readyState === "Loadable";
          return (
            <button type="button" key={adapter.name} className={`wallet-choice-button ${isSelected ? "is-connecting" : ""}`} onClick={() => onChoose(adapter.name)} disabled={connecting && !isSelected}>
              <span className="wallet-choice-icon">{adapter.icon ? <img src={adapter.icon} alt="" /> : <span>◈</span>}</span>
              <strong>{adapter.name}</strong>
              <small>{isSelected && connecting ? "Connexion…" : detected ? "Detected" : "Available"}</small>
            </button>
          );
        })}
      </div>
      {selectedWalletName && (
        <button type="button" className="wallet-confirm-button" onClick={onConnect} disabled={connecting}>
          {connecting ? "Connexion…" : `Ouvrir ${selectedWalletName}`}
        </button>
      )}
      {error && <p className="modal-error-message">{error}</p>}
      <p className="modal-footnote">Sélectionne Phantom, puis clique sur <strong>Ouvrir Phantom</strong>. Phantom doit être déverrouillé et autorisé sur <strong>localhost</strong>.</p>
    </AppModal>
  );
}

function AccessChoiceModal({ pack, onDemo, onWallet, onClose }: {
  pack: Pack; onDemo: () => void; onWallet: () => void; onClose: () => void;
}) {
  return (
    <AppModal title="Choisis comment lancer ce booster" eyebrow="BOOSTER READY" onClose={onClose} className="access-choice-modal">
      <p className="access-choice-copy">Le booster sélectionné coûte <strong>{formatSol(pack.price)}</strong>. Tu peux tester toute l'animation gratuitement ou connecter un wallet pour effectuer une vraie transaction Devnet.</p>
      <div className="access-choice-actions">
        <button type="button" className="demo-mode-button" onClick={onDemo}><span>▶</span><div><strong>Use DEMO mode</strong><small>Aucune transaction, reveal simulé</small></div></button>
        <button type="button" className="connect-mode-button" onClick={onWallet}><span>◈</span><div><strong>Connect wallet</strong><small>Paiement SOL réel sur Devnet</small></div></button>
      </div>
    </AppModal>
  );
}

function BoosterFace({ category, pack, compact = false }: { category: typeof CATEGORIES[0]; pack: Pack; compact?: boolean }) {
  return (
    <>
      <span className="pack-shine" />
      <span className="pack-tier">{pack.badge}</span>
      <span className="pack-icon">{category.img ? <img src={category.img} alt={category.name} /> : category.icon}</span>
      {!compact && <small>{category.name}</small>}
    </>
  );
}

type Card = ReturnType<typeof createMockCard>;

function RevealOverlay({ machineState, category, pack, card, seconds, onDecision }: {
  machineState: string; category: typeof CATEGORIES[0]; pack: Pack; card: Card | null; seconds: number; onDecision: (action: string) => void;
}) {
  const visible = ["centering", "opening", "decision"].includes(machineState);
  if (!visible) return null;
  const timerProgress = `${(seconds / 60) * 360}deg`;
  return (
    <div className={`reveal-overlay stage-${machineState}`} role="dialog" aria-modal="true" aria-label="Révélation du booster">
      <div className="reveal-vignette" />
      <div className="reveal-stage">
        {machineState !== "decision" && (
          <div className="booster-opening-scene">
            <div className="focus-shadow" />
            <div className="focus-pack" style={{ "--pack-gradient": pack.gradient } as React.CSSProperties}>
              <div className="pack-top-fragment" />
              <div className="pack-left-fragment" />
              <div className="pack-right-fragment" />
              <div className="focus-pack-face"><BoosterFace category={category} pack={pack} /></div>
            </div>
            <div className="opening-flash" />
            <div className="opening-particles" aria-hidden="true">
              {Array.from({ length: 14 }, (_, index) => <i key={index} />)}
            </div>
            <p>{machineState === "centering" ? "Booster verrouillé…" : "Ouverture du booster…"}</p>
          </div>
        )}
        {machineState === "decision" && card && (
          <div className="reveal-result">
            <div className="result-card-shell">
              <div className="result-card-art"><span>{card.art}</span><i>{card.rarity}</i></div>
              <div className="result-card-copy">
                <small>{card.set}</small>
                <h2>{card.name}</h2>
                <div className="result-card-value"><span>Valeur de listing simulée</span><strong>{formatSol(card.value)}</strong></div>
              </div>
            </div>
            <div className="reveal-decision-panel">
              <div className="decision-timer">
                <div className="timer-ring" style={{ "--progress": timerProgress } as React.CSSProperties}><span>{seconds}</span></div>
                <div><strong>Décide maintenant</strong><small>secondes restantes</small></div>
              </div>
              <button type="button" className="keep-button" onClick={() => onDecision("keep")}>Garder la carte<small>Achat NFT et transfert encore simulés</small></button>
              <button type="button" className="refund-button" onClick={() => onDecision("refund")}>Refuser la carte<small>Remboursement de 80 % encore simulé</small></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type Props = {
  walletConnectionError?: string;
  clearWalletConnectionError?: () => void;
};

export function PingooMachine({ walletConnectionError = "", clearWalletConnectionError = () => undefined }: Props) {
  const { connection } = useConnection();
  const { connected, connecting, publicKey, signTransaction, wallets, wallet, select, connect, disconnect } = useWallet();
  const { balance: walletBalance, refresh: refreshWalletBalance } = useLiveBalance(publicKey);

  const [packConfigs, setPackConfigs] = useState<Pack[]>(loadPackConfig);
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [packIndex, setPackIndex] = useState(0);
  const [machineState, setMachineState] = useState("idle");
  const [card, setCard] = useState<Card | null>(null);
  const [seconds, setSeconds] = useState(60);
  const [message, setMessage] = useState("Connecte ton wallet Devnet, puis sélectionne un booster.");
  const [launchOrigin, setLaunchOrigin] = useState({ x: 50, y: 130 });
  const [signature, setSignature] = useState<string | null>(null);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [accessChoiceOpen, setAccessChoiceOpen] = useState(false);
  const [pendingWalletName, setPendingWalletName] = useState<string | null>(null);
  const [sessionMode, setSessionMode] = useState("wallet");
  const [sessionStats, setSessionStats] = useState({ spent: 0, returned: 0, pnl: 0, packs: 0 });
  const [lastOutcome, setLastOutcome] = useState<{ action: string; delta: number; returnedValue: number; packPrice: number; mode: string } | null>(null);
  const [lastOpenedCategory, setLastOpenedCategory] = useState<{ id: string; name: string; icon: string; packPrice: number; mode: string } | null>(null);
  const [walletCopied, setWalletCopied] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const shelfRefs = useRef<(HTMLDivElement | null)[]>([]);
  const packRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const timeoutRefs = useRef<number[]>([]);
  const countdownRef = useRef<number | null>(null);
  const outcomeRecordedRef = useRef(false);
  const activeWalletRef = useRef<string | null>(null);

  const category = CATEGORIES[categoryIndex];
  const pack = packConfigs[packIndex];
  const isBusy = !["idle", "complete", "error"].includes(machineState);
  const walletAddress = publicKey?.toBase58?.() || "";
  const pnlTone = sessionStats.pnl > 0 ? "positive" : sessionStats.pnl < 0 ? "negative" : "neutral";

  const appStyle = useMemo(() => ({ "--accent": category.accent, "--accent-soft": category.soft } as React.CSSProperties), [category]);
  const movingPackStyle = useMemo(() => ({ "--from-x": `${launchOrigin.x}px`, "--from-y": `${launchOrigin.y}px`, "--pack-gradient": pack.gradient } as React.CSSProperties), [launchOrigin, pack]);

  const clearAsync = useCallback(() => {
    timeoutRefs.current.forEach(window.clearTimeout);
    timeoutRefs.current = [];
    if (countdownRef.current !== null) window.clearInterval(countdownRef.current);
    countdownRef.current = null;
  }, []);

  const schedule = useCallback((fn: () => void, delay: number) => {
    const timer = window.setTimeout(fn, delay);
    timeoutRefs.current.push(timer);
  }, []);

  useEffect(() => clearAsync, [clearAsync]);

  useEffect(() => {
    if (!connected) return;
    setWalletModalOpen(false);
    setAccessChoiceOpen(false);
    setPendingWalletName(null);
  }, [connected]);

  useEffect(() => {
    if (!walletAddress) { activeWalletRef.current = null; return; }
    if (activeWalletRef.current !== walletAddress) {
      activeWalletRef.current = walletAddress;
      setSessionStats({ spent: 0, returned: 0, pnl: 0, packs: 0 });
      setLastOutcome(null);
      setLastOpenedCategory(null);
    }
  }, [walletAddress]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const shelf = shelfRefs.current[categoryIndex];
    if (!viewport || !shelf) return;
    const target = shelf.offsetTop - (viewport.clientHeight - shelf.clientHeight) / 2;
    viewport.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [categoryIndex]);

  useEffect(() => {
    if (machineState !== "decision") return;
    countdownRef.current = window.setInterval(() => {
      setSeconds((current) => {
        if (current <= 1) {
          if (countdownRef.current !== null) window.clearInterval(countdownRef.current);
          countdownRef.current = null;
          recordOutcome("timeout", card);
          setMachineState("complete");
          setMessage("Temps écoulé. Le résultat est comptabilisé comme un refus avec retour simulé à 80 %.");
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => { if (countdownRef.current !== null) window.clearInterval(countdownRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineState]);

  function applyDashboardConfig(nextConfig: Pack[]) {
    savePackConfig(nextConfig);
    setPackConfigs(nextConfig);
    setPackIndex((current) => Math.min(current, nextConfig.length - 1));
  }

  function chooseWallet(walletName: string) {
    clearWalletConnectionError();
    setPendingWalletName(walletName);
    select(walletName as WalletName);
    setMessage(`${walletName} sélectionné. Clique sur "Ouvrir ${walletName}" pour autoriser la connexion.`);
  }

  async function connectSelectedWallet() {
    clearWalletConnectionError();
    if (!pendingWalletName) { setMessage("Sélectionne d'abord un wallet."); return; }
    if (!wallet?.adapter || wallet.adapter.name !== pendingWalletName) {
      select(pendingWalletName as WalletName);
      setMessage(`${pendingWalletName} est en cours de préparation. Clique de nouveau.`);
      return;
    }
    try {
      await connect();
      setWalletModalOpen(false);
      setAccessChoiceOpen(false);
      setPendingWalletName(null);
      setMessage(`${wallet.adapter.name} connecté avec succès sur Solana Devnet.`);
    } catch (error) {
      setMessage(`Connexion impossible : ${(error as Error)?.message || "Erreur inconnue"}`);
    }
  }

  async function handleDisconnect() {
    clearWalletConnectionError();
    try { await disconnect(); setMessage("Wallet déconnecté."); } catch { /* ignore */ }
  }

  function selectCategory(index: number) {
    if (machineState !== "idle") return;
    setCategoryIndex(index);
    setMessage(`Rayon ${CATEGORIES[index].name} sélectionné.`);
  }

  function selectPack(index: number) {
    if (machineState !== "idle") return;
    setPackIndex(index);
    setMessage(`Booster ${formatSol(packConfigs[index].price)} sélectionné.`);
  }

  function captureSelectedPackOrigin() {
    const viewport = viewportRef.current;
    const selected = packRefs.current[`${category.id}-${pack.id}`];
    if (!viewport || !selected) return;
    const viewportRect = viewport.getBoundingClientRect();
    const packRect = selected.getBoundingClientRect();
    setLaunchOrigin({ x: packRect.left - viewportRect.left + packRect.width / 2, y: packRect.top - viewportRect.top + packRect.height / 2 });
  }

  const sendPayment = useCallback(async () => {
    if (!publicKey) throw new Error("Wallet non connecté.");
    if (!signTransaction) throw new Error("Ce wallet ne permet pas de signer cette transaction.");
    const amountLamports = Math.round(pack.price * LAMPORTS_PER_SOL);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { context, value } = await connection.getLatestBlockhashAndContext({ commitment: "processed" });
        const transaction = new Transaction().add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: TREASURY_PUBLIC_KEY, lamports: amountLamports }));
        transaction.feePayer = publicKey;
        transaction.recentBlockhash = value.blockhash;
        const signedTransaction = await signTransaction(transaction);
        const txSignature = await connection.sendRawTransaction(signedTransaction.serialize(), { skipPreflight: false, preflightCommitment: "processed", minContextSlot: context.slot, maxRetries: 5 });
        setSignature(txSignature);
        const confirmation = await connection.confirmTransaction({ signature: txSignature, blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight }, "confirmed");
        if (confirmation.value.err) throw new Error(`Transaction rejetée : ${JSON.stringify(confirmation.value.err)}`);
        return txSignature;
      } catch (error) {
        if (/blockhash not found|block height exceeded|expired/i.test((error as Error)?.message || "") && attempt === 0) {
          setMessage("Le blockhash Devnet a expiré. Une nouvelle signature va être demandée.");
          continue;
        }
        throw error;
      }
    }
    throw new Error("La transaction Devnet n'a pas pu être envoyée.");
  }, [connection, pack.price, publicKey, signTransaction]);

  function beginRevealSequence(mode: string) {
    setSessionMode(mode);
    setMachineState("dispensing");
    setMessage(mode === "demo" ? "Mode démo activé. Distribution du booster sans transaction." : "Transaction Devnet confirmée. Distribution du booster…");
    schedule(() => { setMachineState("centering"); setMessage("Le booster tombe puis se recentre pour l'ouverture."); }, 1550);
    schedule(() => { setMachineState("opening"); setMessage("Ouverture du booster…"); }, 2750);
    schedule(() => {
      setCard(createMockCard(category, pack));
      setLastOpenedCategory({ id: category.id, name: category.name, icon: category.icon, packPrice: pack.price, mode });
      setMachineState("decision");
      setMessage(mode === "demo" ? "Carte révélée en mode démo. Aucun SOL n'a été envoyé." : "Carte révélée. Le paiement est réel sur Devnet, le NFT reste simulé.");
    }, 4450);
  }

  function prepareMachineRun() {
    clearAsync();
    outcomeRecordedRef.current = false;
    captureSelectedPackOrigin();
    setCard(null);
    setSeconds(60);
    setSignature(null);
  }

  function startDemoMachine() {
    if (machineState !== "idle") return;
    setAccessChoiceOpen(false);
    prepareMachineRun();
    beginRevealSequence("demo");
  }

  async function startMachine() {
    if (machineState !== "idle") return;
    if (!connected || !publicKey) { setAccessChoiceOpen(true); setMessage("Choisis le mode démo ou connecte un wallet Solana."); return; }
    if (walletBalance !== null && walletBalance < pack.price + 0.001) { setMessage(`Solde insuffisant : il faut environ ${formatSol(pack.price + 0.001)} sur Devnet.`); return; }
    prepareMachineRun();
    setSessionMode("wallet");
    setMachineState("paying");
    setMessage(`Confirme le transfert réel de ${formatSol(pack.price)} sur Solana Devnet.`);
    try {
      const txSignature = await sendPayment();
      setSignature(txSignature);
      await Promise.allSettled([refreshWalletBalance()]);
      beginRevealSequence("wallet");
    } catch (error) {
      setMachineState("error");
      setMessage(friendlyTransactionError(error));
      await Promise.allSettled([refreshWalletBalance()]);
    }
  }

  async function copyWalletAddress() {
    if (!walletAddress) return;
    try { await navigator.clipboard.writeText(walletAddress); setWalletCopied(true); schedule(() => setWalletCopied(false), 1400); } catch { setMessage("Impossible de copier automatiquement l'adresse du wallet."); }
  }

  function recordOutcome(action: string, resultCard: Card | null = card) {
    if (!resultCard || outcomeRecordedRef.current) return;
    outcomeRecordedRef.current = true;
    const returnedValue = action === "keep" ? resultCard.value : resultCard.value * 0.8;
    const delta = returnedValue - pack.price;
    setSessionStats((current) => ({ spent: current.spent + pack.price, returned: current.returned + returnedValue, pnl: current.pnl + delta, packs: current.packs + 1 }));
    setLastOutcome({ action, delta, returnedValue, packPrice: pack.price, mode: sessionMode });
  }

  function resetMachine() {
    clearAsync();
    setMachineState("idle");
    setCard(null);
    setSeconds(60);
    setMessage("Machine réinitialisée. Choisis ton prochain booster.");
  }

  function decide(action: string) {
    if (!card || machineState !== "decision") return;
    if (countdownRef.current !== null) window.clearInterval(countdownRef.current);
    countdownRef.current = null;
    recordOutcome(action, card);
    setMachineState("complete");
    if (action === "keep") setMessage("Choix enregistré. L'achat et le transfert du NFT seront connectés dans une prochaine étape.");
    else setMessage(`Carte refusée. Le remboursement de ${formatSol(card.value * 0.8)} est encore simulé.`);
  }

  // exposed so control-panel page can share the same localStorage config
  void applyDashboardConfig;

  const explorerUrl = signature ? `https://explorer.solana.com/tx/${signature}?cluster=devnet` : null;

  return (
    <div className={`app-shell app-state-${machineState}`} style={appStyle}>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      {walletModalOpen && (
        <WalletConnectModal
          wallets={wallets as { adapter: { name: string; icon?: string }; readyState: string }[]}
          selectedWalletName={pendingWalletName || wallet?.adapter?.name || ""}
          connecting={connecting}
          error={walletConnectionError}
          onChoose={chooseWallet}
          onConnect={connectSelectedWallet}
          onClose={() => { if (!connecting) { setWalletModalOpen(false); setPendingWalletName(null); } }}
        />
      )}

      {accessChoiceOpen && (
        <AccessChoiceModal pack={pack} onDemo={startDemoMachine} onWallet={() => { setAccessChoiceOpen(false); setWalletModalOpen(true); }} onClose={() => setAccessChoiceOpen(false)} />
      )}

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div><strong>PINGOO</strong><span>Tokenized Collectibles</span></div>
        </div>
        <div />
        <WalletTopBarButton
          walletConnectionError={walletConnectionError}
          clearWalletConnectionError={clearWalletConnectionError}
          onOpenWalletModal={() => { clearWalletConnectionError(); setWalletModalOpen(true); }}
          onDisconnect={handleDisconnect}
        />
      </header>

      <main className="layout">
        <aside className="category-panel arcade-cabinet">
          <div className="panel-heading">
            <span className="eyebrow">SELECT CATEGORY</span>
            <h2>Choisis ton rayon</h2>
          </div>
          <div className="category-list">
            {CATEGORIES.map((item, index) => (
              <button type="button" key={item.id} className={`category-card ${index === categoryIndex ? "selected" : ""}`} onClick={() => selectCategory(index)} disabled={isBusy}>
                <span className="category-led" />
                <span className="category-icon">{item.img ? <img src={item.img} alt={item.name} /> : item.icon}</span>
                <span className="category-copy"><strong>{item.name}</strong><small>{item.subtitle}</small></span>
                <span className="arcade-arrow">▶</span>
              </button>
            ))}
          </div>
          <div className="arcade-help">
            <strong>DEVNET MODE</strong>
            <small>Les paiements SOL sont réels sur Devnet. Les cartes et remboursements restent simulés.</small>
          </div>
        </aside>

        <section className={`machine state-${machineState}`}>
          <div className="machine-topline">
            <span>Distributeur de cartes à collectionner</span>
            <div className="status-light"><i /><span>{machineState === "idle" ? "PRÊT" : "EN COURS"}</span></div>
          </div>
          <div className="machine-window" ref={viewportRef}>
            <div className="window-reflection" />
            <div className="active-zone" aria-hidden="true" />
            <div className="shelves-track">
              {CATEGORIES.map((shelfCategory, shelfIndex) => (
                <div key={shelfCategory.id} ref={(node) => { shelfRefs.current[shelfIndex] = node; }} className={`shelf-row ${shelfIndex === categoryIndex ? "active" : ""}`} style={{ "--row-accent": shelfCategory.accent, "--row-soft": shelfCategory.soft } as React.CSSProperties}>
                  <div className="shelf-label">
                    {shelfCategory.img ? <img src={shelfCategory.img} alt={shelfCategory.name} className="shelf-label-icon" /> : <span>{shelfCategory.icon}</span>}
                    <div><strong>{shelfCategory.name}</strong><small>{shelfIndex === categoryIndex ? "Rayon actif" : "Autre rayon"}</small></div>
                  </div>
                  <div className="packs-row">
                    {packConfigs.map((packItem, index) => (
                      <div key={packItem.id} className="pack-slot">
                        <button type="button" ref={(node) => { packRefs.current[`${shelfCategory.id}-${packItem.id}`] = node; }} className={`pack tier-${index + 1} ${shelfIndex === categoryIndex && index === packIndex ? "selected" : ""}`} style={{ "--pack-gradient": packItem.gradient } as React.CSSProperties} disabled={shelfIndex !== categoryIndex || isBusy} onClick={() => selectPack(index)} aria-label={`${shelfCategory.name}, booster ${formatSol(packItem.price)}`}>
                          <BoosterFace category={shelfCategory} pack={packItem} compact />
                        </button>
                        <div className="pack-price-tag">{formatSol(packItem.price)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="shelf-rail" />
                </div>
              ))}
            </div>
            <div className="moving-pack" style={movingPackStyle} aria-hidden="true">
              <BoosterFace category={category} pack={pack} />
            </div>
            <div className="delivery-slot"><span>DROP ZONE</span></div>
          </div>
          <div className="control-deck">
            <div className="selected-booster">
              <span>Booster sélectionné</span>
              <strong>{category.name} · {formatSol(pack.price)}</strong>
            </div>
            <button type="button" className="push-button" onClick={["complete", "error"].includes(machineState) ? resetMachine : startMachine} disabled={isBusy}>
              <span className="chevrons">«</span>
              <strong>
                {machineState === "complete" || machineState === "error" ? "REJOUER"
                  : machineState === "idle" ? `PAYER ${formatSol(pack.price)}`
                  : machineState === "paying" ? "CONFIRMATION WALLET…"
                  : "DISTRIBUTION…"}
              </strong>
              <span className="chevrons">»</span>
            </button>
          </div>
        </section>

        <aside className="control-panel glass-panel">
          <div className="player-panel">
            <div className="player-panel-heading">
              <div><span className="eyebrow">PLAYER DEVNET</span><h2>Profil joueur</h2></div>
              <span className={`connection-pill ${connected ? "connected" : ""}`}><i />{connected ? "Connecté" : "Hors ligne"}</span>
            </div>
            <div className="wallet-identity-card">
              <div className="wallet-avatar">{wallet?.adapter?.name?.slice(0, 1) || "◎"}</div>
              <div className="wallet-identity-copy">
                <span>{wallet?.adapter?.name || "Wallet Solana"}</span>
                <strong title={walletAddress}>{walletAddress ? shortAddress(walletAddress) : "Non connecté"}</strong>
              </div>
              {walletAddress && <button type="button" className="copy-wallet-button" onClick={copyWalletAddress}>{walletCopied ? "Copié" : "Copier"}</button>}
            </div>
            <WalletStatus balance={walletBalance} />
            <div className="player-stat-grid">
              <div className="player-stat balance"><span>Solde actuel</span><strong>{walletBalance === null ? "—" : `${walletBalance.toFixed(4)} SOL`}</strong><small>Solana Devnet</small></div>
              <div className={`player-stat pnl ${pnlTone}`}><span>P&amp;L session</span><strong>{formatSignedSol(sessionStats.pnl)}</strong><small>Valeur de jeu simulée</small></div>
              <div className="player-stat last-category">
                <span>Dernière catégorie</span>
                <strong>{lastOpenedCategory ? `${lastOpenedCategory.icon} ${lastOpenedCategory.name}` : "—"}</strong>
                <small>{lastOpenedCategory ? `${formatSol(lastOpenedCategory.packPrice)} · ${lastOpenedCategory.mode === "demo" ? "Démo" : "Devnet"}` : "Aucun pack ouvert"}</small>
              </div>
              <div className="player-stat packs-opened"><span>Packs ouverts</span><strong>{sessionStats.packs}</strong><small>{formatSol(sessionStats.spent)} engagés</small></div>
            </div>
            {lastOutcome && (
              <div className={`last-outcome ${lastOutcome.delta >= 0 ? "positive" : "negative"}`}>
                <span>Dernier résultat</span>
                <strong>{formatSignedSol(lastOutcome.delta)}</strong>
                <small>{lastOutcome.action === "keep" ? "Carte gardée" : lastOutcome.action === "timeout" ? "Temps écoulé · retour 80 %" : "Carte refusée · retour 80 %"}{" · "}{lastOutcome.mode === "demo" ? "démo" : "Devnet"}</small>
              </div>
            )}
            <p className="pnl-disclaimer">Le solde du wallet est lu sur Devnet. Le P&amp;L de jeu reste simulé tant que l'achat NFT et le remboursement ne sont pas connectés.</p>
          </div>

          <section className="booster-odds-panel" aria-label={`Probabilités du booster ${formatSol(pack.price)}`}>
            <div className="booster-odds-heading">
              <div><span className="eyebrow">BOOSTER ODDS</span><h3>Chances du booster sélectionné</h3></div>
              <div className="selected-odds-pack"><span className="odds-pack-dot" style={{ "--pack-gradient": pack.gradient } as React.CSSProperties} /><strong>{formatSol(pack.price)}</strong></div>
            </div>
            <div className="selected-odds-grid odds-only" key={pack.id}>
              <div className="odds-card jackpot"><span>Jackpot</span><strong>{pack.odds.jackpot}%</strong></div>
              <div className="odds-card win"><span>Win</span><strong>{pack.odds.win}%</strong></div>
              <div className="odds-card breakeven"><span>Break-even</span><strong>{pack.odds.breakEven}%</strong></div>
              <div className="odds-card loss"><span>Loss</span><strong>{pack.odds.loss}%</strong></div>
              <div className="odds-card ultraloss"><span>Ultra loss</span><strong>{pack.odds.ultraLoss}%</strong></div>
            </div>
            <div className="booster-odds-footnote">
              <span>Les ratios et fourchettes de luck se règlent dans le Dashboard.</span>
              {explorerUrl && <a href={explorerUrl} target="_blank" rel="noreferrer">Dernière transaction ↗</a>}
            </div>
          </section>

          <div className={`status-message ${machineState}`}>
            <span className="pulse-dot" /><p>{message}</p>
          </div>
        </aside>
      </main>

      <RevealOverlay machineState={machineState} category={category} pack={pack} card={card} seconds={seconds} onDecision={decide} />

      <footer>Solana Devnet · Paiement SOL réel · Révélation, NFT et remboursement encore simulés</footer>
    </div>
  );
}
