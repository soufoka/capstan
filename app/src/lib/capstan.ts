import { AnchorProvider, BN, Program } from "@anchor-lang/core";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import config from "../config.json";
import idl from "../idl/capstan.json";
import type { Capstan } from "../idl/capstan";

export const RPC_URL: string = import.meta.env.VITE_RPC_URL || config.cluster;
export const connection = new Connection(RPC_URL, "confirmed");
export const PROGRAM_ID = new PublicKey(config.programId);
export const MINT = new PublicKey(config.mint);
export const POOL = new PublicKey(config.pool);
export const ARBITER = new PublicKey(config.arbiter);
export const UNIT = 1_000_000;
export const TOKEN = "tUSDC";
export const IS_DEVNET = RPC_URL.includes("devnet");

const readOnlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: async <T>(t: T) => t,
  signAllTransactions: async <T>(t: T) => t,
};
const provider = new AnchorProvider(connection, readOnlyWallet as never, { commitment: "confirmed" });
export const program = new Program<Capstan>(idl as Capstan, provider);

const pda = (...seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const FAUCET_AUTHORITY = pda(Buffer.from("faucet"));
export const POOL_VAULT = pda(Buffer.from("pool_vault"), POOL.toBuffer());
export const SHARE_MINT = pda(Buffer.from("shares"), POOL.toBuffer());
export const dealVaultOf = (deal: PublicKey) => pda(Buffer.from("deal_vault"), deal.toBuffer());
const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
const ensureAta = (payer: PublicKey, mint: PublicKey, owner: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, owner), owner, mint);

export const explorer = (kind: "tx" | "address", id: string) =>
  `https://explorer.solana.com/${kind}/${id}${IS_DEVNET ? "?cluster=devnet" : `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`}`;

// ------------------------------------------------------------------ signing

export interface Actor {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retries calls that hit the public RPC's rate limit (HTTP 429). */
export async function withRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (i >= tries - 1 || !/429|rate limit|Too Many Requests|fetch failed|Failed to fetch/i.test(msg)) throw e;
      await sleep(600 * 2 ** i);
    }
  }
}

export async function send(actor: Actor, ixs: TransactionInstruction[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = actor.publicKey;
  const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash("confirmed"));
  tx.recentBlockhash = blockhash;
  const signed = await actor.signTransaction(tx);
  const raw = signed.serialize();
  const sig = await withRetry(() => connection.sendRawTransaction(raw));
  // poll for confirmation over HTTP instead of opening a websocket per transaction
  for (;;) {
    await sleep(800);
    const { value } = await withRetry(() => connection.getSignatureStatuses([sig]));
    const status = value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return sig;
    const height = await withRetry(() => connection.getBlockHeight("confirmed"));
    if (height > lastValidBlockHeight) throw new Error("Transaction expired before confirmation. Try again.");
  }
}

/** Turns a failed simulation into the program's own error message. */
export function explainError(e: unknown): string {
  const text = String((e as { message?: string })?.message ?? e);
  const logs: string[] = (e as { logs?: string[] })?.logs ?? [];
  const all = text + "\n" + logs.join("\n");
  const hex = all.match(/custom program error: 0x([0-9a-f]+)/i);
  if (hex) {
    const code = parseInt(hex[1], 16);
    if (code === 1 && /Tokenkeg|TokenzQd|insufficient funds/i.test(all)) return `Not enough ${TOKEN} in this wallet.`;
    const err = (idl as { errors?: { code: number; msg: string }[] }).errors?.find((x) => x.code === code);
    if (err) return err.msg;
  }
  const named = all.match(/Error Message: ([^.\n]+)/);
  if (named) return named[1];
  if (/insufficient (funds|lamports)|Attempt to debit an account but found no record/i.test(all))
    return "Not enough SOL to pay fees. Fund the wallet with devnet SOL first.";
  if (/User rejected/i.test(all)) return "Signature request was rejected.";
  return text.slice(0, 180);
}

// ------------------------------------------------------------------ reads

export type DealState = "funded" | "shipped" | "disputed" | "released" | "resolved" | "refunded";

export interface DealView {
  address: PublicKey;
  importer: PublicKey;
  supplier: PublicKey;
  dealId: BN;
  amount: number;
  termsHash: number[];
  shipmentHash: number[];
  createdAt: number;
  shipBy: number;
  releaseWindow: number;
  shippedAt: number;
  advancePrincipal: number;
  advanceFee: number;
  poolRepaid: number;
  supplierPaid: number;
  importerRefunded: number;
  state: DealState;
}

export interface PoolView {
  idle: number;
  outstanding: number;
  feesEarned: number;
  losses: number;
  shareSupply: number;
  shareValue: number;
  advanceFeeBps: number;
  maxAdvanceBps: number;
  advancesPaid: number;
}

const num = (b: BN) => Number(b.toString());

export async function fetchPool(): Promise<PoolView> {
  const [p, vault, supply] = await Promise.all([
    withRetry(() => program.account.pool.fetch(POOL)),
    withRetry(() => connection.getTokenAccountBalance(POOL_VAULT)),
    withRetry(() => connection.getTokenSupply(SHARE_MINT)),
  ]);
  const idle = Number(vault.value.amount);
  const outstanding = num(p.outstandingPrincipal);
  const shareSupply = Number(supply.value.amount);
  return {
    idle,
    outstanding,
    feesEarned: num(p.feesEarned),
    losses: num(p.losses),
    shareSupply,
    shareValue: shareSupply ? (idle + outstanding) / shareSupply : 1,
    advanceFeeBps: p.advanceFeeBps,
    maxAdvanceBps: p.maxAdvanceBps,
    advancesPaid: p.advancesPaid,
  };
}

export async function fetchDeals(): Promise<DealView[]> {
  // Deal layout: 8-byte discriminator, importer (32), supplier (32), pool (32)...
  const rows = await withRetry(() => program.account.deal.all([{ memcmp: { offset: 8 + 64, bytes: POOL.toBase58() } }]));
  return rows
    .map(({ publicKey, account: d }) => ({
      address: publicKey,
      importer: d.importer,
      supplier: d.supplier,
      dealId: d.dealId,
      amount: num(d.amount),
      termsHash: d.termsHash,
      shipmentHash: d.shipmentHash,
      createdAt: num(d.createdAt),
      shipBy: num(d.shipBy),
      releaseWindow: num(d.releaseWindow),
      shippedAt: num(d.shippedAt),
      advancePrincipal: num(d.advancePrincipal),
      advanceFee: num(d.advanceFee),
      poolRepaid: num(d.poolRepaid),
      supplierPaid: num(d.supplierPaid),
      importerRefunded: num(d.importerRefunded),
      state: Object.keys(d.state)[0] as DealState,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function fetchBalances(owner: PublicKey) {
  const [lamports, token, shares] = await Promise.all([
    withRetry(() => connection.getBalance(owner)),
    withRetry(() => connection.getTokenAccountBalance(ata(MINT, owner))).catch(() => null),
    withRetry(() => connection.getTokenAccountBalance(ata(SHARE_MINT, owner))).catch(() => null),
  ]);
  return {
    sol: lamports / LAMPORTS_PER_SOL,
    token: token ? Number(token.value.amount) : 0,
    shares: shares ? Number(shares.value.amount) : 0,
  };
}

export async function sha256(text: string): Promise<number[]> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest));
}

// ------------------------------------------------------------------ writes

const units = (amount: number) => new BN(Math.round(amount * UNIT));

export async function faucetIxs(owner: PublicKey, amount: number) {
  return [
    ensureAta(owner, MINT, owner),
    await program.methods
      .faucet(units(amount))
      .accountsPartial({ mint: MINT, recipientToken: ata(MINT, owner), tokenProgram: TOKEN_PROGRAM_ID })
      .instruction(),
  ];
}

export function fundIxs(from: PublicKey, to: PublicKey[], sol: number) {
  return to.map((t) =>
    SystemProgram.transfer({ fromPubkey: from, toPubkey: t, lamports: Math.round(sol * LAMPORTS_PER_SOL) })
  );
}

export async function depositIxs(owner: PublicKey, amount: number) {
  return [
    ensureAta(owner, SHARE_MINT, owner),
    await program.methods
      .deposit(units(amount))
      .accountsPartial({
        provider: owner,
        pool: POOL,
        mint: MINT,
        shareMint: SHARE_MINT,
        poolVault: POOL_VAULT,
        providerToken: ata(MINT, owner),
        providerShares: ata(SHARE_MINT, owner),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ];
}

export async function withdrawIxs(owner: PublicKey, shares: number) {
  return [
    ensureAta(owner, MINT, owner),
    await program.methods
      .withdraw(new BN(shares))
      .accountsPartial({
        provider: owner,
        pool: POOL,
        mint: MINT,
        shareMint: SHARE_MINT,
        poolVault: POOL_VAULT,
        providerToken: ata(MINT, owner),
        providerShares: ata(SHARE_MINT, owner),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ];
}

export async function createDealIxs(
  importer: PublicKey,
  supplier: PublicKey,
  amount: number,
  shipBy: number,
  releaseWindow: number,
  terms: string
) {
  const dealId = new BN(Date.now());
  const deal = pda(Buffer.from("deal"), importer.toBuffer(), dealId.toArrayLike(Buffer, "le", 8));
  return [
    await program.methods
      .createDeal(dealId, units(amount), new BN(shipBy), new BN(releaseWindow), await sha256(terms))
      .accountsPartial({
        importer,
        supplier,
        pool: POOL,
        mint: MINT,
        deal,
        dealVault: dealVaultOf(deal),
        importerToken: ata(MINT, importer),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ];
}

export async function markShippedIxs(supplier: PublicKey, deal: PublicKey, proof: string) {
  return [
    await program.methods
      .markShipped(await sha256(proof))
      .accountsPartial({ supplier, deal })
      .instruction(),
  ];
}

export async function advanceIxs(supplier: PublicKey, deal: PublicKey, amount: number) {
  return [
    ensureAta(supplier, MINT, supplier),
    await program.methods
      .requestAdvance(units(amount))
      .accountsPartial({
        supplier,
        deal,
        pool: POOL,
        mint: MINT,
        poolVault: POOL_VAULT,
        supplierToken: ata(MINT, supplier),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ];
}

export async function openDisputeIxs(importer: PublicKey, deal: PublicKey) {
  return [await program.methods.openDispute().accountsPartial({ importer, deal }).instruction()];
}

export type SettleKind = "confirm" | "auto" | "resolve" | "refund";

export async function settleIxs(kind: SettleKind, caller: PublicKey, d: DealView, supplierBps = 10_000) {
  const accounts = {
    caller,
    deal: d.address,
    pool: POOL,
    mint: MINT,
    dealVault: dealVaultOf(d.address),
    poolVault: POOL_VAULT,
    supplierToken: ata(MINT, d.supplier),
    importerToken: ata(MINT, d.importer),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const m = program.methods;
  const builder =
    kind === "confirm"
      ? m.confirmDelivery()
      : kind === "auto"
        ? m.autoRelease()
        : kind === "resolve"
          ? m.resolveDispute(supplierBps)
          : m.refundUnshipped();
  return [
    ensureAta(caller, MINT, d.supplier),
    ensureAta(caller, MINT, d.importer),
    await builder.accountsPartial(accounts).instruction(),
  ];
}
