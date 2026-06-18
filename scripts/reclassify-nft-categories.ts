import { getNftDb } from "../src/services/nftSqliteDb";
import { detectRwaNftCategory } from "../src/services/nftCategoryService";
import { detectCollectibleAssetType, publicGroupForAssetType } from "../src/services/nftAssetTypeService";

function parseJson(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function main() {
  const db = getNftDb();
  const rows = db
    .prepare(
      `SELECT mint, name, description, collection, attributes_json, raw_helius_json, category, asset_type, public_group
       FROM nft_assets`,
    )
    .all() as Array<{
      mint: string;
      name: string | null;
      description: string | null;
      collection: string | null;
      attributes_json: string | null;
      raw_helius_json: string | null;
      category: string | null;
      asset_type: string | null;
      public_group: string | null;
    }>;

  const total = rows.length;
  console.log(`[RECLASSIFY] Loaded ${total.toLocaleString("en-US")} NFTs`);

  const update = db.prepare(
    `UPDATE nft_assets
     SET category = ?, asset_type = ?, public_group = ?, updated_at = ?
     WHERE mint = ?`,
  );

  let categoryChanged = 0;
  let assetTypeChanged = 0;
  const now = new Date().toISOString();

  const runBatch = (batch: typeof rows) => {
    db.exec("BEGIN");
    try {
      for (const row of batch) {
        const attributes = parseJson(row.attributes_json);
        const raw = parseJson(row.raw_helius_json);
        const newCategory = detectRwaNftCategory({
          name: row.name,
          description: row.description,
          collection: row.collection,
          attributes_json: attributes,
          attributes,
        });
        const newAssetType = detectCollectibleAssetType({
          name: row.name,
          description: row.description,
          collection: row.collection,
          attributes_json: attributes,
          attributes,
          raw,
        });
        const newPublicGroup = publicGroupForAssetType(newAssetType);

        if (newCategory !== (row.category ?? "unknown")) categoryChanged += 1;
        if (newAssetType !== (row.asset_type ?? "unknown")) assetTypeChanged += 1;

        update.run(newCategory, newAssetType, newPublicGroup, now, row.mint);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  const BATCH = 5000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    runBatch(batch);
    const progress = Math.min(i + BATCH, rows.length);
    console.log(`[RECLASSIFY] ${progress.toLocaleString("en-US")}/${total.toLocaleString("en-US")}  (categoryChanged=${categoryChanged}, assetTypeChanged=${assetTypeChanged})`);
  }

  console.log(`\n[RECLASSIFY] DONE`);
  console.log(`  Total rows:           ${total.toLocaleString("en-US")}`);
  console.log(`  Category changed:     ${categoryChanged.toLocaleString("en-US")}`);
  console.log(`  Asset type changed:   ${assetTypeChanged.toLocaleString("en-US")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
