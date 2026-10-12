// Creates (or reuses) demo keypairs for the importer, supplier and LP roles,
// sends them SOL for fees from the provider wallet and mints test stablecoins
// to the importer. Keys are written to keys/ (git-ignored).
//
// Usage: ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=... npx ts-node scripts/fund-demo.ts
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { Capstan } from "../target/types/capstan";
import idl from "../target/idl/capstan.json";
import config from "../app/src/config.json";

const SOL_EACH = 0.1;
const IMPORTER_TOKENS = 50_000 * 1_000_000;

function key(name: string): Keypair {
  const file = path.join(__dirname, `../keys/demo-${name}.json`);
  if (fs.existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  const program = new Program<Capstan>(idl as Capstan, provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const mint = new PublicKey(config.mint);
  const arbiter = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(__dirname, "../keys/arbiter.json"), "utf8")))
  );
  const wallets = { importer: key("importer"), supplier: key("supplier"), lp: key("lp") };

  const tx = new Transaction();
  for (const kp of [...Object.values(wallets), arbiter]) {
    const bal = await conn.getBalance(kp.publicKey);
    if (bal < (SOL_EACH / 2) * LAMPORTS_PER_SOL) {
      tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: SOL_EACH * LAMPORTS_PER_SOL }));
    }
  }
  if (tx.instructions.length) await provider.sendAndConfirm(tx);

  const importerToken = await getOrCreateAssociatedTokenAccount(conn, payer, mint, wallets.importer.publicKey);
  if (Number(importerToken.amount) < IMPORTER_TOKENS / 2) {
    await program.methods
      .faucet(new BN(IMPORTER_TOKENS))
      .accountsPartial({ mint, recipientToken: importerToken.address, tokenProgram: TOKEN_PROGRAM_ID })
      .rpc();
  }
  for (const [name, kp] of Object.entries({ ...wallets, arbiter })) {
    console.log(name, kp.publicKey.toBase58(), (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL, "SOL");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
