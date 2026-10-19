// Writes for whoever holds a key file (`{ address, privateKey }`): claiming a
// new board and funding accounts on a trial chain.
//
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node scripts/operator.mjs \
//     <key.json> <node URL> <chain path> claim <min per square per block>
//   ... fund <address> <amount>
import { readFileSync } from "node:fs";
import * as board from "../client/board.mjs";
import * as wallet from "../client/wallet.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const [keyFile, node, chain, verb, ...args] = process.argv.slice(2);
const key = JSON.parse(readFileSync(keyFile, "utf8"));
const chainPath = chain.split("/");

async function account(address) {
  const url = new URL(`/api/state/account/${address}`, node);
  url.searchParams.set("chainPath", chain);
  const response = await fetch(url, { cache: "no-store", headers: process.env.COOKIE ? { Authorization: `Basic ${btoa(process.env.COOKIE)}` } : {} });
  return response.ok ? response.json() : { nonce: 0, balance: 0 };
}

const write = verb === "claim"
  ? board.claimBoard(key.address, BigInt(args[0]))
  : verb === "fund"
    ? { actions: [], payments: [{ to: args[0], amount: BigInt(args[1]) }] }
    : null;
if (!write) throw new Error(`unknown verb ${verb}`);
const body = wallet.transaction({ owner: key.address, ...write, fee: 0n, nonce: BigInt((await account(key.address)).nonce ?? 0), chainPath });
const { publicKey, signature } = sdk.signTransactionBody(body, Uint8Array.from(Buffer.from(key.privateKey, "hex")));
const response = await fetch(new URL("/transactions", node), {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(process.env.COOKIE && { Authorization: `Basic ${btoa(process.env.COOKIE)}` }) },
  body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
});
console.log(response.status, await response.text());
