import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

let db: DatabaseSync | null = null;

function dbPath() {
  const override = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.GACHA_SQLITE_DB_PATH;
  return resolve(process.cwd(), override || "data/gacha.sqlite");
}

export function getGachaDb() {
  if (db) return db;
  const file = dbPath();
  mkdirSync(dirname(file), { recursive: true });
  console.log(`[GACHA DB] Initializing persistent database: ${file}`);
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

function runMigrations(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS gacha_draws (
      draw_id TEXT PRIMARY KEY,
      player_wallet TEXT NOT NULL,
      client_nonce TEXT NOT NULL,
      commit_hex TEXT NOT NULL,
      server_seed_hex TEXT,
      pack_price_sol REAL NOT NULL,
      tier_name TEXT,
      tier_value_sol REAL,
      payment_signature TEXT,
      payment_confirmed_at TEXT,
      revealed_at TEXT,
      decision TEXT,
      decision_at TEXT,
      decision_signature TEXT,
      payout_sol REAL,
      status TEXT NOT NULL DEFAULT 'awaiting_payment',
      odds_snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS gacha_draws_status_idx ON gacha_draws (status);
    CREATE INDEX IF NOT EXISTS gacha_draws_wallet_idx ON gacha_draws (player_wallet);
    CREATE INDEX IF NOT EXISTS gacha_draws_created_idx ON gacha_draws (created_at);

    CREATE TABLE IF NOT EXISTS gacha_treasury_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draw_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount_sol REAL NOT NULL,
      signature TEXT,
      memo TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (draw_id) REFERENCES gacha_draws (draw_id)
    );

    CREATE INDEX IF NOT EXISTS gacha_treasury_draw_idx ON gacha_treasury_ledger (draw_id);
  `);
}

export type DrawStatus =
  | "awaiting_payment"
  | "revealed"
  | "accepted"
  | "refused"
  | "expired"
  | "failed";

export type DrawRow = {
  draw_id: string;
  player_wallet: string;
  client_nonce: string;
  commit_hex: string;
  server_seed_hex: string | null;
  pack_price_sol: number;
  tier_name: string | null;
  tier_value_sol: number | null;
  payment_signature: string | null;
  payment_confirmed_at: string | null;
  revealed_at: string | null;
  decision: string | null;
  decision_at: string | null;
  decision_signature: string | null;
  payout_sol: number | null;
  status: DrawStatus;
  odds_snapshot_json: string;
  created_at: string;
  updated_at: string;
};

export function insertDraw(input: {
  drawId: string;
  playerWallet: string;
  clientNonce: string;
  commitHex: string;
  packPriceSol: number;
  oddsSnapshotJson: string;
}) {
  const now = new Date().toISOString();
  getGachaDb()
    .prepare(
      `INSERT INTO gacha_draws (
        draw_id, player_wallet, client_nonce, commit_hex, pack_price_sol,
        status, odds_snapshot_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'awaiting_payment', ?, ?, ?)`,
    )
    .run(
      input.drawId,
      input.playerWallet,
      input.clientNonce,
      input.commitHex,
      input.packPriceSol,
      input.oddsSnapshotJson,
      now,
      now,
    );
}

export function getDraw(drawId: string): DrawRow | null {
  return (
    (getGachaDb()
      .prepare(`SELECT * FROM gacha_draws WHERE draw_id = ?`)
      .get(drawId) as DrawRow | undefined) ?? null
  );
}

export function updateDraw(
  drawId: string,
  patch: Partial<Omit<DrawRow, "draw_id" | "created_at">>,
) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
  values.push(new Date().toISOString());
  values.push(drawId);
  getGachaDb()
    .prepare(`UPDATE gacha_draws SET ${set}, updated_at = ? WHERE draw_id = ?`)
    .run(...(values as Array<string | number | null>));
}

export function appendTreasury(input: {
  drawId: string;
  kind: "pack_in" | "refund_out" | "mint_fee" | "expired_kept";
  amountSol: number;
  signature?: string | null;
  memo?: string | null;
}) {
  getGachaDb()
    .prepare(
      `INSERT INTO gacha_treasury_ledger (draw_id, kind, amount_sol, signature, memo, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.drawId,
      input.kind,
      input.amountSol,
      input.signature ?? null,
      input.memo ?? null,
      new Date().toISOString(),
    );
}

export function listRecentDraws(limit = 50) {
  return getGachaDb()
    .prepare(`SELECT * FROM gacha_draws ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as DrawRow[];
}
