import * as anchor from "@anchor-lang/core";
import { BN, Program } from "@anchor-lang/core";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { createHash } from "crypto";
import { Capstan } from "../target/types/capstan";

const USD = 1_000_000; // 6 decimals
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => [...createHash("sha256").update(s).digest()];

describe("capstan", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.capstan as Program<Capstan>;
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const lp = Keypair.generate();
  const importer = Keypair.generate();
  const supplier = Keypair.generate();
  const arbiter = Keypair.generate();
  const stranger = Keypair.generate();

  let mint: PublicKey;
  let pool: PublicKey;
  let poolVault: PublicKey;
  let shareMint: PublicKey;
  const ata: Record<string, PublicKey> = {};
  let nextDealId = 1;

  const pda = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const balance = async (a: PublicKey) => Number((await getAccount(conn, a)).amount);

  async function expectError(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (e: any) {
      const msg = String(e?.error?.errorCode?.code ?? e?.message ?? e);
      assert.include(msg + JSON.stringify(e?.logs ?? []), code);
      return;
    }
    assert.fail(`expected ${code}`);
  }

  async function createDeal(amount: number, shipInSecs: number, windowSecs: number) {
    const dealId = new BN(nextDealId++);
    const deal = pda([
      Buffer.from("deal"),
      importer.publicKey.toBuffer(),
      dealId.toArrayLike(Buffer, "le", 8),
    ]);
    const dealVault = pda([Buffer.from("deal_vault"), deal.toBuffer()]);
    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .createDeal(
        dealId,
        new BN(amount * USD),
        new BN(now + shipInSecs),
        new BN(windowSecs),
        sha256(`PO-${dealId.toString()}: 2,000 units, FOB Shenzhen`)
      )
      .accountsPartial({
        importer: importer.publicKey,
        supplier: supplier.publicKey,
        pool,
        mint,
        deal,
        dealVault,
        importerToken: ata.importer,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([importer])
      .rpc();
    return { deal, dealVault };
  }

  const settleAccounts = (deal: PublicKey, dealVault: PublicKey, caller: PublicKey) => ({
    caller,
    deal,
    pool,
    mint,
    dealVault,
    poolVault,
    supplierToken: ata.supplier,
    importerToken: ata.importer,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  const ship = (deal: PublicKey, signer = supplier) =>
    program.methods
      .markShipped(sha256(`bill-of-lading-${deal.toBase58()}`))
      .accountsPartial({ supplier: signer.publicKey, deal })
      .signers([signer])
      .rpc();

  const advance = (deal: PublicKey, amount: number) =>
    program.methods
      .requestAdvance(new BN(amount * USD))
      .accountsPartial({
        supplier: supplier.publicKey,
        deal,
        pool,
        mint,
        poolVault,
        supplierToken: ata.supplier,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([supplier])
      .rpc();

  before(async () => {
    for (const kp of [lp, importer, supplier, arbiter, stranger]) {
      const sig = await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
    }
    const faucetAuthority = pda([Buffer.from("faucet")]);
    mint = await createMint(conn, payer, faucetAuthority, null, 6);
    for (const [name, kp] of Object.entries({ lp, importer, supplier })) {
      ata[name] = (await getOrCreateAssociatedTokenAccount(conn, payer, mint, kp.publicKey)).address;
    }
    for (const name of ["lp", "importer"]) {
      await program.methods
        .faucet(new BN(100_000 * USD))
        .accountsPartial({ mint, recipientToken: ata[name], tokenProgram: TOKEN_PROGRAM_ID })
        .rpc();
    }
    pool = pda([Buffer.from("pool"), mint.toBuffer()]);
    poolVault = pda([Buffer.from("pool_vault"), pool.toBuffer()]);
    shareMint = pda([Buffer.from("shares"), pool.toBuffer()]);
  });

  it("faucet refuses to mint above the cap", async () => {
    await expectError(
      program.methods
        .faucet(new BN(100_001 * USD))
        .accountsPartial({ mint, recipientToken: ata.lp, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc(),
      "AdvanceTooLarge"
    );
  });

  it("creates a pool and takes LP liquidity", async () => {
    await program.methods
      .initPool(150, 8000, arbiter.publicKey)
      .accountsPartial({
        admin: payer.publicKey,
        mint,
        pool,
        poolVault,
        shareMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    ata.lpShares = (await getOrCreateAssociatedTokenAccount(conn, payer, shareMint, lp.publicKey)).address;
    await program.methods
      .deposit(new BN(50_000 * USD))
      .accountsPartial({
        provider: lp.publicKey,
        pool,
        mint,
        shareMint,
        poolVault,
        providerToken: ata.lp,
        providerShares: ata.lpShares,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([lp])
      .rpc();
    assert.equal(await balance(poolVault), 50_000 * USD);
    assert.equal(await balance(ata.lpShares), 50_000 * USD);
  });

  it("happy path: escrow, shipment, advance, delivery repays the pool first", async () => {
    const { deal, dealVault } = await createDeal(10_000, 600, 3600);
    assert.equal(await balance(dealVault), 10_000 * USD);

    await expectError(advance(deal, 1_000), "InvalidState"); // not shipped yet
    await expectError(ship(deal, importer), "Unauthorized"); // only the supplier ships
    await ship(deal);

    await expectError(advance(deal, 8_001), "AdvanceTooLarge"); // above 80% of escrow
    await advance(deal, 8_000);
    await expectError(advance(deal, 1), "AdvanceAlreadyTaken");
    assert.equal(await balance(ata.supplier), 8_000 * USD);

    let p = await program.account.pool.fetch(pool);
    assert.equal(p.outstandingPrincipal.toNumber(), 8_000 * USD);

    await program.methods
      .confirmDelivery()
      .accountsPartial(settleAccounts(deal, dealVault, importer.publicKey))
      .signers([importer])
      .rpc();

    // 8,000 principal + 1.5% fee back to the pool, the rest to the supplier
    assert.equal(await balance(poolVault), 50_120 * USD);
    assert.equal(await balance(ata.supplier), (8_000 + 1_880) * USD);
    p = await program.account.pool.fetch(pool);
    assert.equal(p.outstandingPrincipal.toNumber(), 0);
    assert.equal(p.feesEarned.toNumber(), 120 * USD);
    const d = await program.account.deal.fetch(deal);
    assert.deepEqual(d.state, { released: {} });
  });

  it("dispute: arbiter splits, supplier share repays the pool, shortfall is a loss", async () => {
    const supplierBefore = await balance(ata.supplier);
    const importerBefore = await balance(ata.importer);
    const { deal, dealVault } = await createDeal(5_000, 600, 3600);
    await ship(deal);
    await advance(deal, 4_000); // fee 60

    await program.methods
      .openDispute()
      .accountsPartial({ importer: importer.publicKey, deal })
      .signers([importer])
      .rpc();

    await expectError(
      program.methods
        .resolveDispute(3000)
        .accountsPartial(settleAccounts(deal, dealVault, stranger.publicKey))
        .signers([stranger])
        .rpc(),
      "Unauthorized"
    );

    await program.methods
      .resolveDispute(3000) // 30% to the supplier
      .accountsPartial(settleAccounts(deal, dealVault, arbiter.publicKey))
      .signers([arbiter])
      .rpc();

    // supplier share 1,500 all goes to the pool; importer gets 3,500 back
    assert.equal(await balance(ata.supplier), supplierBefore + 4_000 * USD);
    assert.equal(await balance(ata.importer), importerBefore - 5_000 * USD + 3_500 * USD);
    const p = await program.account.pool.fetch(pool);
    assert.equal(p.losses.toNumber(), 2_500 * USD);
    assert.equal(p.outstandingPrincipal.toNumber(), 0);
    const d = await program.account.deal.fetch(deal);
    assert.deepEqual(d.state, { resolved: {} });
  });

  it("auto-release: anyone can release after the inspection window", async () => {
    const supplierBefore = await balance(ata.supplier);
    const { deal, dealVault } = await createDeal(1_000, 600, 30);
    await ship(deal);
    const release = () =>
      program.methods
        .autoRelease()
        .accountsPartial(settleAccounts(deal, dealVault, stranger.publicKey))
        .signers([stranger])
        .rpc();
    await expectError(release(), "WindowStillOpen");
    await sleep(32_000);
    await expectError(
      program.methods
        .openDispute()
        .accountsPartial({ importer: importer.publicKey, deal })
        .signers([importer])
        .rpc(),
      "WindowClosed"
    );
    await release();
    assert.equal(await balance(ata.supplier), supplierBefore + 1_000 * USD);
  });

  it("refund: importer recovers funds when the supplier misses the ship date", async () => {
    const importerBefore = await balance(ata.importer);
    const { deal, dealVault } = await createDeal(2_000, 2, 3600);
    await sleep(4_000);
    await expectError(ship(deal), "ShipDeadlinePassed");
    await program.methods
      .refundUnshipped()
      .accountsPartial(settleAccounts(deal, dealVault, importer.publicKey))
      .signers([importer])
      .rpc();
    assert.equal(await balance(ata.importer), importerBefore);
    const d = await program.account.deal.fetch(deal);
    assert.deepEqual(d.state, { refunded: {} });
  });

  it("LP withdraws pro-rata after fees and losses", async () => {
    // 50,000 deposited + 120 fee earned - 2,500 lost in the dispute = 47,620
    assert.equal(await balance(poolVault), 47_620 * USD);
    const before = await balance(ata.lp);
    await program.methods
      .withdraw(new BN(10_000 * USD))
      .accountsPartial({
        provider: lp.publicKey,
        pool,
        mint,
        shareMint,
        poolVault,
        providerToken: ata.lp,
        providerShares: ata.lpShares,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([lp])
      .rpc();
    // 10,000 of 50,000 shares = 20% of 47,620
    assert.equal((await balance(ata.lp)) - before, 9_524 * USD);
  });
});
