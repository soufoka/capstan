// Bootstraps a Capstan pool on the configured cluster:
//   1. creates a 6-decimal test stablecoin whose mint authority is the program's faucet PDA
//   2. creates the pool (1.5% advance fee, up to 80% of escrow), with a dedicated arbiter key
//   3. seeds the pool with liquidity from the deployer wallet
// Writes the addresses to app/src/config.json for the web app.
//
// Usage: ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json \
//        npx ts-node scripts/setup.ts
import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { Capstan } from "../target/types/capstan";
import idl from "../target/idl/capstan.json";

const USD = 1_000_000;
const SEED_LIQUIDITY = 50_000 * USD;

function loadOrCreateKey(file: string): Keypair {
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program<Capstan>(idl as Capstan, provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];

  const arbiter = loadOrCreateKey(path.join(__dirname, "../keys/arbiter.json"));
  const faucetAuthority = pda([Buffer.from("faucet")]);
  const mint = await createMint(conn, payer, faucetAuthority, null, 6);
  const pool = pda([Buffer.from("pool"), mint.toBuffer()]);
  const poolVault = pda([Buffer.from("pool_vault"), pool.toBuffer()]);
  const shareMint = pda([Buffer.from("shares"), pool.toBuffer()]);
  console.log("mint", mint.toBase58());

  await program.methods
    .initPool(150, 8000, arbiter.publicKey)
    .accountsPartial({ admin: payer.publicKey, mint, pool, poolVault, shareMint, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();
  console.log("pool", pool.toBase58());

  const token = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  const shares = await getOrCreateAssociatedTokenAccount(conn, payer, shareMint, payer.publicKey);
  await program.methods
    .faucet(new BN(SEED_LIQUIDITY))
    .accountsPartial({ mint, recipientToken: token.address, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();
  await program.methods
    .deposit(new BN(SEED_LIQUIDITY))
    .accountsPartial({
      provider: payer.publicKey,
      pool,
      mint,
      shareMint,
      poolVault,
      providerToken: token.address,
      providerShares: shares.address,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("seeded pool with", SEED_LIQUIDITY / USD, "test USDC");

  const config = {
    cluster: conn.rpcEndpoint,
    programId: program.programId.toBase58(),
    mint: mint.toBase58(),
    pool: pool.toBase58(),
    arbiter: arbiter.publicKey.toBase58(),
  };
  fs.writeFileSync(path.join(__dirname, "../app/src/config.json"), JSON.stringify(config, null, 2) + "\n");
  console.log(config);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
