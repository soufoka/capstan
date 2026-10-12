import { ConnectionProvider, useWallet, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Actor,
  advanceIxs,
  ARBITER,
  connection,
  createDealIxs,
  DealView,
  depositIxs,
  explainError,
  explorer,
  faucetIxs,
  fetchBalances,
  fetchDeals,
  fetchPool,
  fundIxs,
  IS_DEVNET,
  markShippedIxs,
  MINT,
  openDisputeIxs,
  POOL,
  PoolView,
  PROGRAM_ID,
  RPC_URL,
  send,
  settleIxs,
  SettleKind,
  TOKEN,
  UNIT,
  withdrawIxs,
} from "./lib/capstan";
import { keypairActor, loadDemoKeypair, Role, ROLES } from "./lib/wallets";

// ------------------------------------------------------------------ helpers

const money = (units: number) =>
  (units / UNIT).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (k: PublicKey | string) => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
const shortHash = (bytes: number[]) => {
  const h = hex(bytes);
  return `${h.slice(0, 6)}…${h.slice(-6)}`;
};
const duration = (secs: number) => {
  if (secs <= 0) return "0s";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
};
const when = (ts: number) =>
  new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

const SHIP_BY = [
  { label: "1 hour", secs: 3600 },
  { label: "1 day", secs: 86400 },
  { label: "7 days", secs: 7 * 86400 },
  { label: "30 days", secs: 30 * 86400 },
];
const WINDOWS = [
  { label: "30 seconds (demo)", secs: 30 },
  { label: "2 minutes (demo)", secs: 120 },
  { label: "3 days", secs: 3 * 86400 },
  { label: "14 days", secs: 14 * 86400 },
];

interface LogEntry {
  label: string;
  sig?: string;
  error?: string;
  at: number;
}

type RunFn = (label: string, build: (a: Actor) => Promise<TransactionInstruction[]>, as?: Actor) => Promise<boolean>;

// ------------------------------------------------------------------ app

export default function App() {
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <Shell />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function Shell() {
  const wallet = useWallet();
  const [mode, setMode] = useState<"demo" | "wallet">("demo");
  const [role, setRole] = useState<Role>("importer");
  const [pool, setPool] = useState<PoolView | null>(null);
  const [deals, setDeals] = useState<DealView[]>([]);
  const [bal, setBal] = useState({ sol: 0, token: 0, shares: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [loadError, setLoadError] = useState<string | null>(null);

  const demo = useMemo(() => {
    const out = {} as Record<Role, Keypair | null>;
    for (const r of ROLES) out[r.id] = loadDemoKeypair(r.id);
    return out;
  }, []);

  const actor: Actor | null = useMemo(() => {
    if (mode === "demo") {
      const kp = demo[role];
      return kp ? keypairActor(kp) : null;
    }
    if (wallet.publicKey && wallet.signTransaction) {
      return { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction };
    }
    return null;
  }, [mode, role, demo, wallet.publicKey, wallet.signTransaction]);

  const refresh = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([fetchPool(), fetchDeals()]);
      setPool(p);
      setDeals(d);
      setLoadError(null);
    } catch (e) {
      setLoadError(explainError(e));
    }
    if (actor) setBal(await fetchBalances(actor.publicKey).catch(() => ({ sol: 0, token: 0, shares: 0 })));
  }, [actor]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const run: RunFn = async (label, build, as) => {
    const signer = as ?? actor;
    if (!signer) return false;
    setBusy(label);
    try {
      const sig = await send(signer, await build(signer));
      setLog((l) => [{ label, sig, at: Date.now() }, ...l].slice(0, 12));
      await refresh();
      return true;
    } catch (e) {
      setLog((l) => [{ label, error: explainError(e), at: Date.now() }, ...l].slice(0, 12));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const fundDemoWallets = async () => {
    const targets = (["importer", "supplier", "lp"] as Role[]).map((r) => demo[r]!.publicKey);
    if (wallet.publicKey && wallet.signTransaction) {
      const payer = { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction };
      await run("Fund demo wallets with 0.05 SOL each", async () => fundIxs(payer.publicKey, targets, 0.05), payer);
      return;
    }
    setBusy("Requesting devnet SOL");
    try {
      for (const t of targets) {
        const sig = await connection.requestAirdrop(t, 0.5 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(sig, "confirmed");
        setLog((l) => [{ label: `Airdrop to ${short(t)}`, sig, at: Date.now() }, ...l]);
      }
    } catch {
      setLog((l) => [
        {
          label: "Airdrop",
          error: "The public devnet faucet is rate limited. Connect a devnet wallet and fund the demo wallets from it, or use faucet.solana.com.",
          at: Date.now(),
        },
        ...l,
      ]);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const me = actor?.publicKey;
  const isArbiter = !!me && me.equals(ARBITER);
  const supplierDefault = demo.supplier?.publicKey.toBase58() ?? "";

  return (
    <div className="page">
      <header className="top">
        <a className="brand" href="/">
          <img src="/logo.svg" alt="" width={36} height={36} />
          <span>
            <strong>Capstan</strong>
            <small>Escrow-backed advances for cross-border trade</small>
          </span>
        </a>
        <div className="top-right">
          <span className="pill">{IS_DEVNET ? "Solana devnet" : "Local validator"}</span>
          <WalletMultiButton />
        </div>
      </header>

      <section className="acting">
        <div className="mode">
          <button className={mode === "demo" ? "on" : ""} onClick={() => setMode("demo")}>
            Demo wallets
          </button>
          <button className={mode === "wallet" ? "on" : ""} onClick={() => setMode("wallet")}>
            My wallet
          </button>
        </div>
        <div className="roles" role="tablist">
          {ROLES.map((r) => (
            <button
              key={r.id}
              role="tab"
              aria-selected={role === r.id}
              className={role === r.id ? "on" : ""}
              onClick={() => setRole(r.id)}
              title={r.blurb}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="whoami">
          {me ? (
            <>
              <a href={explorer("address", me.toBase58())} target="_blank" rel="noreferrer" className="mono">
                {short(me)}
              </a>
              <span className="mono">{bal.sol.toFixed(3)} SOL</span>
              <span className="mono">
                {money(bal.token)} {TOKEN}
              </span>
              <button
                className="ghost"
                disabled={!!busy || bal.sol === 0}
                onClick={() => run(`Mint 10,000 ${TOKEN} from the test faucet`, (a) => faucetIxs(a.publicKey, 10_000))}
              >
                Get 10,000 {TOKEN}
              </button>
              {mode === "demo" && bal.sol < 0.01 && (
                <button className="ghost" disabled={!!busy} onClick={fundDemoWallets}>
                  Fund demo wallets
                </button>
              )}
            </>
          ) : mode === "wallet" ? (
            <span className="muted">Connect a wallet set to devnet.</span>
          ) : (
            <span className="muted">The arbiter key is held by the pool operator.</span>
          )}
        </div>
        <p className="blurb">{ROLES.find((r) => r.id === role)?.blurb}</p>
      </section>

      {busy && (
        <div className="busy" role="status">
          <span className="spinner" /> {busy}…
        </div>
      )}
      {loadError && <div className="alert">Could not read the pool: {loadError}</div>}

      <main className="grid">
        <aside>
          <PoolCard pool={pool} />
          {role === "lp" && actor && pool && <LpActions run={run} pool={pool} bal={bal} busy={!!busy} />}
          <OnChain />
        </aside>
        <section className="deals">
          {role === "importer" && actor && (
            <NewDeal run={run} busy={!!busy} supplierDefault={mode === "demo" ? supplierDefault : ""} />
          )}
          <h2 className="section-title">
            Deals <span className="count">{deals.length}</span>
          </h2>
          {deals.length === 0 && <p className="muted">No deals yet. Switch to Importer to open one.</p>}
          {deals.map((d) => (
            <DealCard key={d.address.toBase58()} d={d} pool={pool} me={me} isArbiter={isArbiter} now={now} run={run} busy={!!busy} />
          ))}
        </section>
      </main>

      <section className="activity">
        <h2 className="section-title">Activity</h2>
        {log.length === 0 && <p className="muted">Transactions you sign in this session show up here.</p>}
        <ul>
          {log.map((e, i) => (
            <li key={i} className={e.error ? "err" : ""}>
              <span>{e.label}</span>
              {e.sig ? (
                <a href={explorer("tx", e.sig)} target="_blank" rel="noreferrer" className="mono">
                  {short(e.sig)} ↗
                </a>
              ) : (
                <span className="errmsg">{e.error}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <footer className="foot">
        Capstan is live on Solana devnet with a test stablecoin ({TOKEN}). Program{" "}
        <a href={explorer("address", PROGRAM_ID.toBase58())} target="_blank" rel="noreferrer" className="mono">
          {short(PROGRAM_ID)}
        </a>
        . Open source, MIT license.
      </footer>
    </div>
  );
}

// ------------------------------------------------------------------ pool

function PoolCard({ pool }: { pool: PoolView | null }) {
  if (!pool) return <div className="card pool">Loading pool…</div>;
  const total = pool.idle + pool.outstanding;
  const utilization = total ? pool.outstanding / total : 0;
  return (
    <div className="card pool">
      <h2>Advance pool</h2>
      <div className="big mono">
        {money(total)} <small>{TOKEN}</small>
      </div>
      <div className="bar" aria-label={`Utilization ${(utilization * 100).toFixed(0)}%`}>
        <span style={{ width: `${Math.min(100, utilization * 100)}%` }} />
      </div>
      <dl>
        <dt>Idle liquidity</dt>
        <dd className="mono">{money(pool.idle)}</dd>
        <dt>Advanced to suppliers</dt>
        <dd className="mono">{money(pool.outstanding)}</dd>
        <dt>Fees earned</dt>
        <dd className="mono good">{money(pool.feesEarned)}</dd>
        <dt>Losses</dt>
        <dd className="mono bad">{money(pool.losses)}</dd>
        <dt>Share value</dt>
        <dd className="mono">{pool.shareValue.toFixed(6)}</dd>
        <dt>Advance fee</dt>
        <dd className="mono">{(pool.advanceFeeBps / 100).toFixed(2)}%</dd>
        <dt>Max advance</dt>
        <dd className="mono">{pool.maxAdvanceBps / 100}% of escrow</dd>
        <dt>Advances paid</dt>
        <dd className="mono">{pool.advancesPaid}</dd>
      </dl>
    </div>
  );
}

function LpActions({ run, pool, bal, busy }: { run: RunFn; pool: PoolView; bal: { token: number; shares: number }; busy: boolean }) {
  const [amount, setAmount] = useState("5000");
  const myValue = bal.shares * pool.shareValue;
  return (
    <div className="card">
      <h3>Your position</h3>
      <p className="mono">
        {money(bal.shares)} shares ≈ {money(myValue)} {TOKEN}
      </p>
      <label>
        Amount ({TOKEN})
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <div className="row">
        <button
          disabled={busy || !(Number(amount) > 0)}
          onClick={() => run(`Deposit ${amount} ${TOKEN} into the pool`, (a) => depositIxs(a.publicKey, Number(amount)))}
        >
          Deposit
        </button>
        <button
          className="secondary"
          disabled={busy || bal.shares === 0}
          onClick={() => {
            const shares = Math.min(bal.shares, Math.floor((Number(amount) * UNIT) / pool.shareValue));
            return run(`Withdraw ${amount} ${TOKEN}`, (a) => withdrawIxs(a.publicKey, shares));
          }}
        >
          Withdraw
        </button>
      </div>
      <p className="hint">Only idle liquidity can be withdrawn. Capital lent to suppliers returns when their escrow releases.</p>
    </div>
  );
}

function OnChain() {
  const rows: [string, string][] = [
    ["Program", PROGRAM_ID.toBase58()],
    ["Pool", POOL.toBase58()],
    [`${TOKEN} mint`, MINT.toBase58()],
    ["Arbiter", ARBITER.toBase58()],
  ];
  return (
    <div className="card onchain">
      <h3>Verify on-chain</h3>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              <a href={explorer("address", v)} target="_blank" rel="noreferrer" className="mono">
                {short(v)} ↗
              </a>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ------------------------------------------------------------------ deals

function NewDeal({ run, busy, supplierDefault }: { run: RunFn; busy: boolean; supplierDefault: string }) {
  const [supplier, setSupplier] = useState(supplierDefault);
  const [amount, setAmount] = useState("10000");
  const [terms, setTerms] = useState("PO-2041 · 1,200 units · FOB Shenzhen · ship within 7 days");
  const [shipBy, setShipBy] = useState(SHIP_BY[2].secs);
  const [windowSecs, setWindowSecs] = useState(WINDOWS[1].secs);
  useEffect(() => setSupplier(supplierDefault), [supplierDefault]);

  let supplierKey: PublicKey | null = null;
  try {
    supplierKey = new PublicKey(supplier.trim());
  } catch {
    supplierKey = null;
  }

  return (
    <div className="card newdeal">
      <h2>Open a deal</h2>
      <p className="hint">The full order amount is locked in a program-owned escrow until delivery.</p>
      <div className="form">
        <label className="wide">
          Supplier wallet
          <input className="mono" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Supplier address" />
        </label>
        <label>
          Order amount ({TOKEN})
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label>
          Ship by
          <select value={shipBy} onChange={(e) => setShipBy(Number(e.target.value))}>
            {SHIP_BY.map((o) => (
              <option key={o.secs} value={o.secs}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Inspection window
          <select value={windowSecs} onChange={(e) => setWindowSecs(Number(e.target.value))}>
            {WINDOWS.map((o) => (
              <option key={o.secs} value={o.secs}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          Purchase order terms (stored as a SHA-256 hash)
          <input value={terms} onChange={(e) => setTerms(e.target.value)} />
        </label>
      </div>
      <button
        disabled={busy || !supplierKey || !(Number(amount) > 0)}
        onClick={() =>
          run(`Lock ${Number(amount).toLocaleString("en-US")} ${TOKEN} in escrow`, (a) =>
            createDealIxs(a.publicKey, supplierKey!, Number(amount), Math.floor(Date.now() / 1000) + shipBy, windowSecs, terms)
          )
        }
      >
        Lock funds in escrow
      </button>
    </div>
  );
}

const STATE_LABEL: Record<DealView["state"], string> = {
  funded: "Funded",
  shipped: "Shipped",
  disputed: "Disputed",
  released: "Released",
  resolved: "Resolved",
  refunded: "Refunded",
};

function DealCard({
  d,
  pool,
  me,
  isArbiter,
  now,
  run,
  busy,
}: {
  d: DealView;
  pool: PoolView | null;
  me?: PublicKey;
  isArbiter: boolean;
  now: number;
  run: RunFn;
  busy: boolean;
}) {
  const isImporter = !!me && me.equals(d.importer);
  const isSupplier = !!me && me.equals(d.supplier);
  const releaseAt = d.shippedAt + d.releaseWindow;
  const windowOpen = d.state === "shipped" && now < releaseAt;
  const settled = ["released", "resolved", "refunded"].includes(d.state);
  const cap = pool ? Math.floor((d.amount * pool.maxAdvanceBps) / 10_000) : 0;
  const [proof, setProof] = useState("Bill of lading MSKU 7741203");
  const [adv, setAdv] = useState("");
  const [split, setSplit] = useState(50);
  const advUnits = Math.round((Number(adv || cap / UNIT) || 0) * UNIT);
  const fee = pool ? Math.floor((advUnits * pool.advanceFeeBps) / 10_000) : 0;
  const settle = (kind: SettleKind, label: string, bps?: number) => run(label, (a) => settleIxs(kind, a.publicKey, d, bps));

  return (
    <article className={`card deal state-${d.state}`}>
      <header>
        <div>
          <span className={`badge ${d.state}`}>{STATE_LABEL[d.state]}</span>
          <a href={explorer("address", d.address.toBase58())} target="_blank" rel="noreferrer" className="mono dealid">
            Deal {short(d.address)} ↗
          </a>
        </div>
        <div className="amount mono">
          {money(d.amount)} <small>{TOKEN}</small>
        </div>
      </header>

      <div className="parties">
        <span>
          Importer <b className="mono">{short(d.importer)}</b>
          {isImporter && <em>you</em>}
        </span>
        <span>
          Supplier <b className="mono">{short(d.supplier)}</b>
          {isSupplier && <em>you</em>}
        </span>
        <span>
          Terms <b className="mono">{shortHash(d.termsHash)}</b>
        </span>
      </div>

      <ol className="steps">
        <li className="done">
          <b>Escrow funded</b>
          <span>{when(d.createdAt)}</span>
        </li>
        <li className={d.shippedAt ? "done" : d.state === "funded" ? "now" : ""}>
          <b>Shipped</b>
          <span>
            {d.shippedAt
              ? `${when(d.shippedAt)} · proof ${shortHash(d.shipmentHash)}`
              : now <= d.shipBy
                ? `due in ${duration(d.shipBy - now)}`
                : "ship date missed"}
          </span>
        </li>
        <li className={d.advancePrincipal ? "done" : windowOpen ? "now" : ""}>
          <b>Supplier advance</b>
          <span>
            {d.advancePrincipal
              ? `${money(d.advancePrincipal)} paid · fee ${money(d.advanceFee)}`
              : settled
                ? "not used"
                : `up to ${money(cap)} after shipment`}
          </span>
        </li>
        <li className={settled ? "done" : d.state === "disputed" ? "now warn" : windowOpen ? "now" : ""}>
          <b>{d.state === "disputed" ? "In dispute" : settled ? STATE_LABEL[d.state] : "Release"}</b>
          <span>
            {settled
              ? "settled on-chain"
              : d.state === "disputed"
                ? "waiting for the arbiter"
                : d.state === "shipped"
                  ? windowOpen
                    ? `auto-release in ${duration(releaseAt - now)}`
                    : "window closed, anyone can release"
                  : "after delivery"}
          </span>
        </li>
      </ol>

      {settled && (
        <div className="payout mono">
          <span>
            Pool repaid <b>{money(d.poolRepaid)}</b>
          </span>
          <span>
            Supplier <b>{money(d.supplierPaid)}</b>
          </span>
          <span>
            Importer <b>{money(d.importerRefunded)}</b>
          </span>
        </div>
      )}

      <div className="actions">
        {isSupplier && d.state === "funded" && now <= d.shipBy && (
          <div className="action">
            <input value={proof} onChange={(e) => setProof(e.target.value)} aria-label="Proof of shipment" />
            <button disabled={busy || !proof.trim()} onClick={() => run("Post proof of shipment", (a) => markShippedIxs(a.publicKey, d.address, proof))}>
              Mark shipped
            </button>
          </div>
        )}
        {isSupplier && windowOpen && d.advancePrincipal === 0 && (
          <div className="action">
            <input
              inputMode="decimal"
              value={adv}
              placeholder={(cap / UNIT).toFixed(2)}
              onChange={(e) => setAdv(e.target.value)}
              aria-label="Advance amount"
            />
            <button
              disabled={busy || advUnits <= 0 || advUnits > cap}
              onClick={() => run(`Draw ${money(advUnits)} ${TOKEN} advance`, (a) => advanceIxs(a.publicKey, d.address, advUnits / UNIT))}
            >
              Draw advance
            </button>
            <span className="hint">
              Fee {money(fee)} {TOKEN}, repaid automatically from the escrow.
            </span>
          </div>
        )}
        {isImporter && windowOpen && (
          <div className="action">
            <button disabled={busy} onClick={() => settle("confirm", "Confirm delivery and release escrow")}>
              Confirm delivery
            </button>
            <button className="danger" disabled={busy} onClick={() => run("Open a dispute", (a) => openDisputeIxs(a.publicKey, d.address))}>
              Open dispute
            </button>
          </div>
        )}
        {d.state === "shipped" && !windowOpen && me && (
          <div className="action">
            <button disabled={busy} onClick={() => settle("auto", "Release escrow after the inspection window")}>
              Release escrow
            </button>
          </div>
        )}
        {isImporter && d.state === "funded" && now > d.shipBy && (
          <div className="action">
            <button disabled={busy} onClick={() => settle("refund", "Refund unshipped order")}>
              Refund
            </button>
          </div>
        )}
        {isArbiter && d.state === "disputed" && (
          <div className="action resolve">
            <label>
              Supplier gets {split}% · importer gets {100 - split}%
              <input type="range" min={0} max={100} step={5} value={split} onChange={(e) => setSplit(Number(e.target.value))} />
            </label>
            <button disabled={busy} onClick={() => settle("resolve", `Resolve dispute ${split}/${100 - split}`, split * 100)}>
              Resolve
            </button>
          </div>
        )}
      </div>
    </article>
  );
}
