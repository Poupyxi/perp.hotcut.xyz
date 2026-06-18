// Mints a brand-new NFT on Solana devnet using Metaplex Umi (mpl-token-metadata).
// The mint is signed by the server wallet and the NFT goes directly to the
// player's wallet in a single atomic transaction.
//
// MVP devnet only: metadata URI points to a static JSON we host in /public.
// TODO (prod): replace this with an atomic buy+transfer from the live
// marketplace via the order's settlement program.

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplTokenMetadata, createV1, mintV1, TokenStandard } from "@metaplex-foundation/mpl-token-metadata";
import { generateSigner, keypairIdentity, percentAmount, publicKey } from "@metaplex-foundation/umi";
import { getServerKeypair, rpcUrl } from "./solana";

export type MintedNft = {
  mintAddress: string;
  signature: string;
  metadataUri: string;
  name: string;
};

function umi() {
  const inst = createUmi(rpcUrl());
  inst.use(mplTokenMetadata());
  const sk = getServerKeypair().secretKey;
  const kp = inst.eddsa.createKeypairFromSecretKey(sk);
  inst.use(keypairIdentity(kp));
  return inst;
}

export async function mintTestCardToPlayer(input: {
  playerWallet: string;
  cardName: string;
  metadataUri: string;
}): Promise<MintedNft> {
  const u = umi();
  const mint = generateSigner(u);
  const player = publicKey(input.playerWallet);

  const builder = createV1(u, {
    mint,
    authority: u.identity,
    name: input.cardName.slice(0, 32),
    uri: input.metadataUri.slice(0, 200),
    sellerFeeBasisPoints: percentAmount(0),
    tokenStandard: TokenStandard.NonFungible,
  }).add(
    mintV1(u, {
      mint: mint.publicKey,
      authority: u.identity,
      amount: 1,
      tokenOwner: player,
      tokenStandard: TokenStandard.NonFungible,
    }),
  );

  const result = await builder.sendAndConfirm(u);
  const signature = Buffer.from(result.signature).toString("base64");

  return {
    mintAddress: mint.publicKey.toString(),
    signature,
    metadataUri: input.metadataUri,
    name: input.cardName,
  };
}
