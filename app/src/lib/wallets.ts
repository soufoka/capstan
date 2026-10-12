import { Keypair, Transaction } from "@solana/web3.js";
import type { Actor } from "./capstan";

export type Role = "lp" | "importer" | "supplier" | "arbiter";

export const ROLES: { id: Role; label: string; blurb: string }[] = [
  { id: "importer", label: "Importer", blurb: "Locks the order amount in escrow and confirms delivery." },
  { id: "supplier", label: "Supplier", blurb: "Ships, posts proof, and draws an advance against the escrow." },
  { id: "lp", label: "Liquidity provider", blurb: "Funds supplier advances and earns the advance fee." },
  { id: "arbiter", label: "Arbiter", blurb: "Splits the escrow when a shipment is disputed." },
];

const key = (role: Role) => `capstan.demo.${role}`;

/**
 * Demo wallets are devnet keypairs kept in this browser, one per role, so a
 * single person can walk through a deal from both sides. The arbiter key is
 * only present when the pool operator loads it.
 */
export function loadDemoKeypair(role: Role): Keypair | null {
  try {
    const raw = localStorage.getItem(key(role));
    if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    if (role === "arbiter") return null;
    const kp = Keypair.generate();
    localStorage.setItem(key(role), JSON.stringify(Array.from(kp.secretKey)));
    return kp;
  } catch {
    return role === "arbiter" ? null : Keypair.generate();
  }
}

export function keypairActor(kp: Keypair): Actor {
  return {
    publicKey: kp.publicKey,
    signTransaction: async (tx: Transaction) => {
      tx.partialSign(kp);
      return tx;
    },
  };
}
