// Wheatpaste against a real node: a private host mines Nexus and a board
// chain launched from chain/spec.json with the built policy, whose genesis
// pays the premine to the owner. The owner claims the board; Bob posts;
// Carol covers a corner of Bob's post, which comes down whole and pays Bob
// back; the ways of doing that without paying are refused; the owner cuts
// the board and sells half to Bob; and Dan posts over Carol across both parcels, a
// write across both parcels.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/board.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as board from "../client/board.mjs";
import { tip, view, volumeLoader } from "../client/state.mjs";
import * as wallet from "../client/wallet.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const CHAIN = ["Nexus", "wheatpaste"];
const [listen, rpc, publicRead] = [25031, 29290, 29291];
const node = `http://127.0.0.1:${publicRead}`;
const MODULE = here("../policy/target/wasm32-unknown-unknown/release/wheatpaste_policy.wasm");
const SPEC = here("../chain/spec.json");

const root = mkdtempSync(`${tmpdir()}/wheatpaste-e2e-`);
const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
function configure(change) {
  const file = `${root}/lattice.json`;
  const topology = JSON.parse(readFileSync(file, "utf8"));
  change(topology);
  writeFileSync(file, JSON.stringify(topology, null, 2));
}

const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const [miner, owner, bob, carol, dan] = [account(), account(), account(), account(), account()];

async function until(label, condition, seconds = Number(process.env.E2E_SECONDS ?? 300)) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function api(path) {
  const url = new URL(path, node);
  url.searchParams.set("chainPath", CHAIN.join("/"));
  const response = await fetch(url, { cache: "no-store" });
  return response.ok ? response.json() : undefined;
}
const balance = async (who) => BigInt((await api(`/api/state/account/${who.address}`))?.balance ?? 0);
const nonce = async (who) => BigInt((await api(`/api/state/account/${who.address}`))?.nonce ?? 0);
const volumes = () => new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: CHAIN }));

/** The board at the node's tip, read through the client. */
async function read() {
  const client = volumes();
  const t = await tip(sdk, node, CHAIN, client);
  const s = view(volumeLoader(client, sdk.decodeDagCbor), t.generalStateCID);
  const entries = [];
  for (const prefix of ["parcel/", "cell/"]) for await (const entry of s.list(prefix)) entries.push(entry);
  const { height } = await api("/api/block/latest");
  return board.readBoard(entries, height);
}

async function submit(who, body) {
  const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
  const response = await fetch(new URL("/transactions", node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

/** Sends a write, again while the node answers that the tip moved before it was checked. */
async function send(who, write) {
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const before = write.actions.length > 100 ? (await api("/api/block/latest"))?.height : 0;
    const result = await submit(who, wallet.transaction({ owner: who.address, ...write, fee: 1n, nonce: await nonce(who), chainPath: CHAIN }));
    if (write.actions.length > 100) console.log(`  (${write.actions.length} actions: ${result.status} after ${Date.now() - started} ms, tip ${before} → ${(await api("/api/block/latest"))?.height})`);
    if (result.status !== 503 || attempt === 5) return result;
  }
}

async function admitted(label, who, write) {
  const result = await send(who, write);
  assert.ok(result.ok, `${label}: ${result.status} ${result.text}`);
  console.log(`  admitted: ${label}`);
}

async function refused(label, who, write) {
  const result = await send(who, write);
  assert.ok(!result.ok, `${label} was admitted`);
  console.log(`  refused: ${label} (${result.status} ${result.text.trim()})`);
}

const terms = (b, poster, rect, rate, blocks, id) => ({ poster: poster.address, id, rect, rate, start: b.height, end: b.height + BigInt(blocks) });
const without = (w, key) => ({ ...w, actions: w.actions.filter((a) => a.key !== key) });

try {
  lattice("init");
  configure((topology) => {
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true });
    topology.publicReadExpensiveRate = 1000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("child", "create", CHAIN.join("/"), "--spec", SPEC, "--policy-module", MODULE, "--premine-to", owner.address);
  configure((topology) => {
    topology.mine.recipients = { Nexus: miner.address, [CHAIN.join("/")]: miner.address };
  });
  lattice("up");
  lattice("mine", "start");

  await until("the board's genesis is mined", async () => (await balance(owner)) > 0n);
  console.log(`board launched; the owner holds ${await balance(owner)}`);
  for (const who of [bob, carol, dan]) {
    await admitted("the owner funds a poster", owner, { actions: [], payments: [{ to: who.address, amount: 1_000_000n }] });
    await until("the poster is funded", async () => (await balance(who)) === 1_000_000n);
  }

  await admitted("the owner claims the board at 1 per cell per block", owner, board.claimBoard(owner.address, 1n));
  await until("the board is claimed", async () => (await read()).parcels.length === 1);

  // Bob posts 4 × 4 at 2 per cell for 200 blocks: the write names the board's parcel unchanged.
  let b = await read();
  await admitted("Bob posts 4×4", bob, board.post(b, terms(b, bob, { x: 0, y: 0, w: 4, h: 4 }, 2n, 200, "bike"), { title: "Bob's bikes" }));
  await until("Bob's post is up", async () => board.upPosts(await read()).length === 1);
  const [bobs] = board.upPosts(await read());
  console.log(`Bob's post is up through block ${bobs.end}`);

  // Carol covers one corner. Every way short of the rule is refused.
  b = await read();
  const t = terms(b, carol, { x: 3, y: 3, w: 2, h: 2 }, 0n, 100, "cafe");
  const q = board.quotePost(b, t);
  assert.equal(q.replaces, 32n + 3n);
  const cover = board.post(b, { ...t, rate: q.minRate }, { title: "Carol's cafe" });
  await refused("Carol covers below the rate", carol, { ...board.post(b, { ...t, rate: q.minRate }, {}), actions: board.quotePost(b, { ...t, rate: q.minRate - 1n }).actions });
  await refused("Carol leaves the rest of Bob's post up", carol, without(cover, "cell/0,0"));
  await refused("Carol skips Bob's payback", carol, { ...cover, payments: cover.payments.filter((p) => p.to !== bob.address) });
  await refused("Carol hides the parcel under her post", carol, without(cover, board.parcelKey(board.BOARD)));
  await refused("Carol takes Bob's post down without posting", carol, board.takeDown(bobs));
  const [bobBefore, ownerBefore] = [await balance(bob), await balance(owner)];
  const payback = cover.payments.find((p) => p.to === bob.address).amount;
  await admitted(`Carol covers a corner at ${q.minRate} per cell`, carol, cover);
  await until("Carol's post replaces Bob's", async () => board.upPosts(await read()).map((p) => p.poster).join() === carol.address);
  b = await read();
  assert.equal(b.cells.size, 4, "Bob's other cells are cleared");
  assert.equal(await balance(bob), bobBefore + payback);
  assert.equal(await balance(owner), ownerBefore + cover.payments.find((p) => p.to === owner.address).amount);
  console.log(`Bob's post came down whole; Bob was paid back ${payback}`);

  // The owner cuts the board and sells the right half to Bob.
  await admitted("the owner cuts the board at column 16", owner, board.cutParcel(b, b.parcels[0], { axis: "x", at: 16 }));
  await until("the board is in two parcels", async () => (await read()).parcels.length === 2);
  b = await read();
  const right = b.parcels.find((p) => p.rect.x === 16);
  await refused("Bob takes the right half unlisted", bob, { actions: [{ key: right.key, oldValue: right.value, newValue: `${bob.address} 1` }] });
  await admitted("the owner lists the right half at 50,000", owner, board.setParcel(right, { ask: 50_000n }));
  await until("the right half is listed", async () => (await read()).parcels.some((p) => p.ask === 50_000n));
  b = await read();
  await admitted("Bob buys the right half", bob, board.buyParcel(b.parcels.find((p) => p.ask === 50_000n), bob.address));
  await until("Bob owns the right half", async () => (await read()).parcels.some((p) => p.owner === bob.address));

  // Dan posts across both parcels, over Carol. (A full-board write of 579
  // actions is checked on the trial chain: this local chain mines about two
  // blocks a second, faster than the node admits so large a write.)
  b = await read();
  const full = terms(b, dan, { x: 3, y: 0, w: 16, h: 9 }, 0n, 50, "everything");
  const whole = board.post(b, { ...full, rate: board.quotePost(b, full).minRate }, { title: "Dan's everything" });
  console.log(`  the write has ${whole.actions.length} actions and pays ${whole.payments.length} accounts`);
  await admitted("Dan posts 16×9 across both parcels, over Carol", dan, whole);
  await until("Dan's post is up", async () => {
    const after = await read();
    return board.upPosts(after).map((p) => p.poster).join() === dan.address && after.cells.size === 144;
  });
  console.log("Dan's post is up; Carol's came down whole");
  console.log("PASS");
} finally {
  try {
    lattice("mine", "stop");
  } catch {}
  try {
    lattice("down");
  } catch {}
}
