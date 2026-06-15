import type { RwaNftMarketEvent, RwaNftMarketEventType } from "@/types/rwaNftMarket";

type ParseOptions = {
  fallbackMint?: string | null;
  fallbackOwner?: string | null;
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const result = asString(value);
    if (result && result.toUpperCase() !== "UNKNOWN") return result;
  }
  return null;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function detectEventType(tx: Record<string, unknown>): RwaNftMarketEventType | null {
  const typeText = String(tx.type ?? tx.transactionType ?? tx.description ?? "").toUpperCase();
  if (typeText.includes("NFT_SALE") || typeText.includes("SALE")) return "SALE";
  if (typeText.includes("LIST")) return "LISTED";
  if (typeText.includes("DELIST")) return "DELISTED";
  if (typeText.includes("PRICE")) return "PRICE_UPDATED";
  if (typeText.includes("TRANSFER")) return "TRANSFER";
  return null;
}

function isNftTransfer(transfer: Record<string, unknown>) {
  const tokenStandard = String(transfer.tokenStandard ?? "").toLowerCase();
  return tokenStandard.includes("nonfungible") && Boolean(asString(transfer.mint));
}

function isUsdcMint(mint: unknown) {
  return asString(mint) === USDC_MINT;
}

function tokenSymbolFromMint(mint: string | null) {
  if (!mint) return "SOL";
  if (mint === USDC_MINT) return "USDC";
  return "UNKNOWN";
}

function withParserMetadata(tx: Record<string, unknown>, metadata: Record<string, unknown>) {
  return {
    ...tx,
    _perpRwa: {
      ...(asRecord(tx._perpRwa)),
      ...metadata,
    },
  };
}

function nativePaymentAmount(transfer: Record<string, unknown> | undefined) {
  const amount = numberFromUnknown(transfer?.amount);
  return amount !== null && amount > 100_000 ? amount / 1_000_000_000 : amount;
}

function fungiblePaymentDetails(transfer: Record<string, unknown> | undefined) {
  if (!transfer) return { paymentMint: null, paymentSymbol: null, paymentAmount: null };
  const paymentMint = asString(transfer.mint);
  return {
    paymentMint,
    paymentSymbol: tokenSymbolFromMint(paymentMint),
    paymentAmount: numberFromUnknown(transfer.tokenAmount),
  };
}

function findTransferSaleFallback(tx: Record<string, unknown>, fallbackMint?: string | null): RwaNftMarketEvent | null {
  const tokenTransfers = recordArray(tx.tokenTransfers);
  const nativeTransfers = recordArray(tx.nativeTransfers);
  const nftTransfer = tokenTransfers.find((transfer) => {
    if (!isNftTransfer(transfer)) return false;
    const mint = asString(transfer.mint);
    return !fallbackMint || mint === fallbackMint;
  });

  if (!nftTransfer) return null;

  const mint = asString(nftTransfer.mint);
  const seller = asString(nftTransfer.fromUserAccount);
  const owner = asString(nftTransfer.toUserAccount);
  if (!mint || !seller || !owner || seller === owner) return null;

  const nativePayment = nativeTransfers.find((transfer) => {
    const amount = numberFromUnknown(transfer.amount);
    const payer = asString(transfer.fromUserAccount);
    return amount !== null && amount > 0 && Boolean(payer) && payer !== seller && asString(transfer.toUserAccount) === seller;
  });
  const fungiblePayment = tokenTransfers.find((transfer) => {
    const amount = numberFromUnknown(transfer.tokenAmount);
    const tokenStandard = String(transfer.tokenStandard ?? "").toLowerCase();
    const payer = asString(transfer.fromUserAccount);
    return tokenStandard === "fungible" && amount !== null && amount > 0 && Boolean(payer) && payer !== seller && asString(transfer.toUserAccount) === seller;
  });

  if (!nativePayment && !fungiblePayment) return null;

  const buyer = asString(fungiblePayment?.fromUserAccount) ?? asString(nativePayment?.fromUserAccount);
  if (!buyer) return null;

  const nativeAmount = numberFromUnknown(nativePayment?.amount);
  const fungibleAmount = numberFromUnknown(fungiblePayment?.tokenAmount);
  const priceSol = nativeAmount ? nativeAmount / 1_000_000_000 : null;
  const priceUsd = isUsdcMint(fungiblePayment?.mint) ? fungibleAmount : null;
  const fungibleDetails = fungiblePaymentDetails(fungiblePayment);
  const paymentMint = fungibleDetails.paymentMint;
  const paymentSymbol = fungibleDetails.paymentSymbol ?? (nativePayment ? "SOL" : null);
  const paymentAmount = fungibleDetails.paymentAmount ?? nativePaymentAmount(nativePayment);
  const marketplace = firstString(tx.source, tx.marketplace);

  return {
    mint,
    category: null,
    eventType: "SALE",
    priceSol,
    priceUsd,
    paymentMint,
    paymentSymbol,
    paymentAmount,
    marketplace,
    txSignature: firstString(tx.signature, tx.transactionSignature, tx.txHash),
    buyer,
    seller,
    owner,
    eventAt: timestampFromTx(tx),
    source: "helius_enhanced_tx",
    rawPayload: withParserMetadata(tx, {
      fallbackVerified: true,
      fallbackReason: "Helius type was UNKNOWN and parser detected NFT transfer plus payment transfer",
      paymentMint,
      paymentSymbol,
      paymentAmount,
    }),
  };
}

function isMarketplaceSource(source: string | null) {
  const value = String(source ?? "").toLowerCase();
  return ["magic_eden", "magic eden", "tensor", "hyperspace", "solanart"].some((pattern) => value.includes(pattern));
}

function accountAddresses(tx: Record<string, unknown>) {
  return (Array.isArray(tx.accountData) ? tx.accountData : [])
    .map((row) => asString(asRecord(row).account))
    .filter((value): value is string => Boolean(value));
}

function inferMarketplaceNativeSale(tx: Record<string, unknown>, owner: string | null) {
  const nativeTransfers = recordArray(tx.nativeTransfers)
    .map((transfer) => ({
      from: asString(transfer.fromUserAccount) ?? asString(transfer.fromAddress),
      to: asString(transfer.toUserAccount) ?? asString(transfer.toAddress),
      amountLamports: numberFromUnknown(transfer.amount),
    }))
    .filter((transfer) => transfer.from && transfer.to && transfer.amountLamports && transfer.amountLamports > 100_000)
    .sort((a, b) => (b.amountLamports ?? 0) - (a.amountLamports ?? 0));

  if (!nativeTransfers.length) return null;

  if (owner) {
    const ownerOutgoings = nativeTransfers.filter((transfer) => transfer.from === owner && transfer.to !== owner);
    const sellerPayouts = nativeTransfers.filter((transfer) => transfer.to !== owner && transfer.from !== owner);
    const sellerPayout = sellerPayouts[0] ?? null;
    const ownerOutgoing = ownerOutgoings[0] ?? null;

    if (sellerPayout && ownerOutgoing && sellerPayout.amountLamports && ownerOutgoing.amountLamports) {
      return {
        buyer: owner,
        seller: sellerPayout.to,
        priceSol: sellerPayout.amountLamports / 1_000_000_000,
      };
    }

    if (ownerOutgoing && ownerOutgoing.amountLamports) {
      return {
        buyer: owner,
        seller: ownerOutgoing.to,
        priceSol: ownerOutgoing.amountLamports / 1_000_000_000,
      };
    }
  }

  const largest = nativeTransfers[0];
  if (!largest || !largest.amountLamports) return null;
  return {
    buyer: owner,
    seller: largest.to,
    priceSol: largest.amountLamports / 1_000_000_000,
  };
}

function findMarketplaceUnknownSaleFallback(tx: Record<string, unknown>, options: ParseOptions = {}): RwaNftMarketEvent | null {
  const mint = options.fallbackMint ? asString(options.fallbackMint) : nftMintFromTx(tx, options.fallbackMint);
  const owner = asString(options.fallbackOwner);
  const marketplace = firstString(tx.source, tx.marketplace);
  if (!mint || !marketplace || !isMarketplaceSource(marketplace)) return null;

  const typeText = String(tx.type ?? tx.transactionType ?? "").toUpperCase();
  if (typeText && !["UNKNOWN", "DEPOSIT"].includes(typeText)) return null;

  const accounts = accountAddresses(tx);
  if (!accounts.includes(mint)) return null;
  if (owner && !accounts.includes(owner)) return null;

  const inferredSale = inferMarketplaceNativeSale(tx, owner);
  if (!inferredSale || !inferredSale.priceSol) return null;

  return {
    mint,
    category: null,
    eventType: "SALE",
    priceSol: inferredSale.priceSol,
    priceUsd: null,
    paymentMint: null,
    paymentSymbol: "SOL",
    paymentAmount: inferredSale.priceSol,
    marketplace,
    txSignature: firstString(tx.signature, tx.transactionSignature, tx.txHash),
    buyer: inferredSale.buyer,
    seller: inferredSale.seller,
    owner,
    eventAt: timestampFromTx(tx),
    source: "helius_enhanced_tx",
    rawPayload: withParserMetadata(tx, {
      fallbackVerified: true,
      fallbackReason: "Helius type was marketplace settlement and payment flow confirmed a sale",
      paymentMint: null,
      paymentSymbol: "SOL",
      paymentAmount: inferredSale.priceSol,
      inferredMarketplaceSale: true,
    }),
  };
}

function nftMintFromTx(tx: Record<string, unknown>, fallbackMint?: string | null) {
  const nftEvent = asRecord(tx.nft);
  const events = asRecord(tx.events);
  const nft = asRecord(events.nft);
  const eventNfts = recordArray(nft.nfts);
  const nfts = Array.isArray(tx.nfts) ? tx.nfts.map(asRecord) : [];
  const transfers = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers.map(asRecord) : [];
  return firstString(
    tx.mint,
    tx.assetMint,
    tx.mintAddress,
    nftEvent.mint,
    nftEvent.assetMint,
    nft.mint,
    nft.assetMint,
    eventNfts.find((row) => isNftTransfer(row))?.mint,
    eventNfts[0]?.mint,
    nfts[0]?.mint,
    nfts[0]?.assetMint,
    transfers.find((transfer) => isNftTransfer(transfer))?.mint,
    fallbackMint,
  );
}

function solAmount(tx: Record<string, unknown>) {
  const events = asRecord(tx.events);
  const nft = asRecord(events.nft);
  const nativeTransfers = recordArray(tx.nativeTransfers);
  const nftAmount = numberFromUnknown(nft.amount ?? nft.price);
  if (typeof nftAmount === "number") return nftAmount > 100_000 ? nftAmount / 1_000_000_000 : nftAmount;

  const amount = numberFromUnknown(tx.amount ?? tx.price);
  if (typeof amount === "number") return amount > 100_000 ? amount / 1_000_000_000 : amount;

  const largestTransfer = nativeTransfers
    .map((transfer) => numberFromUnknown(transfer.amount))
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => b - a)[0];
  if (typeof largestTransfer === "number") return largestTransfer > 100_000 ? largestTransfer / 1_000_000_000 : largestTransfer;

  return asNumber(tx.priceSol) ?? asNumber(nft.priceSol) ?? null;
}

function timestampFromTx(tx: Record<string, unknown>) {
  const raw = tx.timestamp ?? tx.blockTime ?? tx.createdAt ?? tx.time;
  if (typeof raw === "number") return new Date(raw < 10_000_000_000 ? raw * 1000 : raw).toISOString();
  return asString(raw) ?? new Date().toISOString();
}

function buyerSellerFromTransfers(tx: Record<string, unknown>) {
  const events = asRecord(tx.events);
  const nft = asRecord(events.nft);
  const nativeTransfers = recordArray(tx.nativeTransfers);
  const tokenTransfers = recordArray(tx.tokenTransfers);
  const nftTransfer = tokenTransfers.find((transfer) => asString(transfer.mint));
  const largestNativeTransfer = nativeTransfers
    .filter((transfer) => numberFromUnknown(transfer.amount) !== null)
    .sort((a, b) => (numberFromUnknown(b.amount) ?? 0) - (numberFromUnknown(a.amount) ?? 0))[0];

  return {
    buyer: firstString(
      tx.buyer,
      nft.buyer,
      nft.buyerAddress,
      nftTransfer?.toUserAccount,
      nftTransfer?.toTokenAccount,
      largestNativeTransfer?.toUserAccount,
    ),
    seller: firstString(
      tx.seller,
      nft.seller,
      nft.sellerAddress,
      nftTransfer?.fromUserAccount,
      nftTransfer?.fromTokenAccount,
      largestNativeTransfer?.fromUserAccount,
    ),
  };
}

function paymentFromTransfers(tx: Record<string, unknown>, buyer: string | null, seller: string | null) {
  const nativeTransfers = recordArray(tx.nativeTransfers);
  const tokenTransfers = recordArray(tx.tokenTransfers);

  const fungiblePayment = tokenTransfers.find((transfer) => {
    const tokenStandard = String(transfer.tokenStandard ?? "").toLowerCase();
    const amount = numberFromUnknown(transfer.tokenAmount);
    const from = asString(transfer.fromUserAccount);
    const to = asString(transfer.toUserAccount);
    return tokenStandard === "fungible"
      && amount !== null
      && amount > 0
      && (!buyer || from === buyer)
      && (!seller || to === seller);
  });

  if (fungiblePayment) return fungiblePaymentDetails(fungiblePayment);

  const nativePayment = nativeTransfers.find((transfer) => {
    const amount = nativePaymentAmount(transfer);
    const from = asString(transfer.fromUserAccount);
    const to = asString(transfer.toUserAccount);
    return amount !== null
      && amount > 0
      && (!buyer || from === buyer)
      && (!seller || to === seller);
  });

  if (nativePayment) {
    return {
      paymentMint: null,
      paymentSymbol: "SOL",
      paymentAmount: nativePaymentAmount(nativePayment),
    };
  }

  return { paymentMint: null, paymentSymbol: null, paymentAmount: null };
}

export function parseHeliusEnhancedTransaction(txPayload: unknown, options: ParseOptions = {}): RwaNftMarketEvent[] {
  const rows = Array.isArray(txPayload) ? txPayload.map(asRecord) : [asRecord(txPayload)];
  const events: RwaNftMarketEvent[] = [];

  for (const tx of rows) {
    const eventType = detectEventType(tx);
    if (!eventType) {
      const transferSale = findTransferSaleFallback(tx, options.fallbackMint);
      if (transferSale) {
        events.push(transferSale);
        continue;
      }
      const marketplaceSale = findMarketplaceUnknownSaleFallback(tx, options);
      if (marketplaceSale) events.push(marketplaceSale);
      continue;
    }

    const mint = nftMintFromTx(tx, options.fallbackMint);
    if (!mint) continue;

    const heliusEvents = asRecord(tx.events);
    const nft = asRecord(heliusEvents.nft);
    const marketplace = firstString(tx.source, tx.marketplace, nft.source, nft.marketplace);
    const { buyer, seller } = buyerSellerFromTransfers(tx);
    const owner = firstString(tx.owner, tx.toUserAccount, buyer);
    const payment = eventType === "SALE" ? paymentFromTransfers(tx, buyer, seller) : { paymentMint: null, paymentSymbol: null, paymentAmount: null };
    const priceSol = eventType === "SALE" || eventType === "LISTED" || eventType === "PRICE_UPDATED" ? solAmount(tx) : null;
    const priceUsd = asNumber(tx.priceUsd) ?? asNumber(nft.priceUsd);

    events.push({
      mint,
      category: null,
      eventType,
      priceSol,
      priceUsd,
      paymentMint: payment.paymentMint,
      paymentSymbol: payment.paymentSymbol ?? (eventType === "SALE" && priceSol !== null ? "SOL" : null),
      paymentAmount: payment.paymentAmount ?? (eventType === "SALE" && priceSol !== null ? priceSol : null),
      marketplace,
      txSignature: firstString(tx.signature, tx.transactionSignature, tx.txHash),
      buyer,
      seller,
      owner,
      eventAt: timestampFromTx(tx),
      source: "helius_enhanced_tx",
      rawPayload: withParserMetadata(tx, {
        fallbackVerified: false,
        paymentMint: payment.paymentMint,
        paymentSymbol: payment.paymentSymbol ?? (eventType === "SALE" && priceSol !== null ? "SOL" : null),
        paymentAmount: payment.paymentAmount ?? (eventType === "SALE" && priceSol !== null ? priceSol : null),
      }),
    });
  }

  return events;
}
