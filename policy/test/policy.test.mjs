// Runs the built policy module the way the Lattice host does (host.mjs), on
// writes built by the client (client/board.mjs) and on hand-made ones.
// Bodies are encoded by the SDK, whose encoding is pinned to Lattice's vectors.
//
//   cargo build --release --target wasm32-unknown-unknown
//   LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { context, validate } from "./host.mjs";
import * as board from "../../client/board.mjs";

const core = await import(process.env.LATTICE_SDK_CORE);
const address = (seed) => core.addressFromPublicKey(core.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));
const OWNER = address(1);
const BOB = address(2);
const CAROL = address(3);
const DAN = address(4);
const PATH = ["Nexus", "testnet", "wheatpaste"];

// With CONTEXT_DIR set, every context is recorded with its verdict so
// host-check can replay it through Lattice's own evaluator.
const contextDirectory = process.env.CONTEXT_DIR;
if (contextDirectory) mkdirSync(contextDirectory, { recursive: true });
let recorded = 0;

function encode(signer, { actions, payments = [] }) {
  const paid = payments.reduce((sum, p) => sum + BigInt(p.amount), 0n);
  return core.encodeTransactionBody({
    accountActions: [
      ...(paid > 0n ? [{ owner: signer, delta: -paid }] : []),
      ...payments.map(({ to, amount }) => ({ owner: to, delta: BigInt(amount) })),
    ],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [signer],
    nonce: 1n,
    chainPath: PATH,
  }).bytes;
}

function accepts(signer, write, height) {
  const bytes = context(encode(signer, write), { path: PATH, height: BigInt(height) });
  const accepted = validate(bytes);
  if (contextDirectory) {
    writeFileSync(`${contextDirectory}/${String(recorded++).padStart(3, "0")}-${accepted ? "accept" : "reject"}.bin`, bytes);
  }
  return accepted;
}

/** A chain of one board: applies a write the policy accepts, as consensus would. */
function chain() {
  const state = new Map();
  let height = 100;
  return {
    get height() { return height; },
    advance(blocks) { height += blocks; },
    board: () => board.readBoard(state, height),
    accepts: (signer, write) => accepts(signer, write, height),
    send(signer, write) {
      for (const { key, oldValue } of write.actions) assert.equal(state.get(key), oldValue, `old value of ${key}`);
      if (!accepts(signer, write, height)) return false;
      for (const { key, newValue } of write.actions) {
        if (newValue === undefined) state.delete(key);
        else state.set(key, newValue);
      }
      return true;
    },
  };
}

/** A chain whose board belongs to OWNER at a minimum of 1 per cell per block. */
function owned(min = 1n) {
  const c = chain();
  assert.ok(c.send(OWNER, board.claimBoard(OWNER, min)));
  return c;
}

const terms = (c, poster, rect, rate, blocks, id = "ad") => ({ poster, id, rect, rate, start: c.height, end: c.height + blocks });
const write = (c, t) => board.post(c.board(), t, { image: "bafkreiexample" });
const quote = (c, t) => board.quotePost(c.board(), t);
const without = (w, key) => ({ ...w, actions: w.actions.filter((a) => a.key !== key) });
const paying = (w, to, amount) => ({ ...w, payments: w.payments.map((p) => (p.to === to ? { ...p, amount } : p)) });

test("the first write gives the whole board to whoever signs it", () => {
  assert.ok(owned());
  const c = chain();
  assert.ok(!c.accepts(BOB, board.claimBoard(OWNER, 1n)));
  assert.ok(!c.accepts(OWNER, { actions: [{ key: "parcel/0,0,16,18", newValue: `${OWNER} 1` }] }));
  assert.ok(!c.accepts(OWNER, { actions: [{ key: "parcel/0,0,33,18", newValue: `${OWNER} 1` }] }));
  assert.ok(!c.accepts(OWNER, { actions: [{ key: "parcel/0,0,32,18", newValue: "-" }] }));
  assert.ok(!c.accepts(OWNER, { actions: [{ key: "parcel/0,0,32,18", newValue: `${OWNER} 01` }] }));
});

test("a post on empty cells pays the owner its rate for every cell and block", () => {
  const c = owned();
  const t = terms(c, BOB, { x: 2, y: 3, w: 4, h: 2 }, 1n, 100);
  const w = write(c, t);
  assert.deepEqual(w.payments, [{ to: OWNER, amount: 800n }]);
  assert.ok(!c.accepts(BOB, paying(w, OWNER, 799n)));
  assert.ok(!c.accepts(CAROL, w), "only the poster signs their post");
  assert.ok(!c.accepts(BOB, without(w, "parcel/0,0,32,18")), "the post names the parcel under it");
  assert.ok(!c.accepts(BOB, without(w, "cell/5,4")), "every cell of the rectangle");
  assert.ok(c.send(BOB, w));
  assert.equal(board.upPosts(c.board()).length, 1);
});

test("a post meets the owner's minimum on empty cells", () => {
  const c = owned(3n);
  const t = terms(c, BOB, { x: 0, y: 0, w: 2, h: 2 }, 2n, 10);
  assert.equal(quote(c, t).minRate, 3n);
  assert.throws(() => write(c, t));
  const forced = { actions: quote(c, t).actions, payments: quote(c, t).payments };
  assert.ok(!c.accepts(BOB, forced));
  assert.ok(c.send(BOB, write(c, { ...t, rate: 3n })));
});

test("a post's start is at or below the block it lands in, and it ends after", () => {
  const c = owned();
  const rect = { x: 0, y: 0, w: 1, h: 1 };
  assert.ok(!c.accepts(BOB, write(c, { poster: BOB, id: "a", rect, rate: 1n, start: c.height + 1, end: c.height + 10 })));
  assert.ok(!c.accepts(BOB, write(c, { poster: BOB, id: "a", rect, rate: 1n, start: c.height - 10, end: c.height })));
  assert.ok(c.accepts(BOB, write(c, { poster: BOB, id: "a", rect, rate: 1n, start: c.height - 10, end: c.height + 1 })));
});

test("one post per write, written to exactly its rectangle", () => {
  const c = owned();
  const w = write(c, terms(c, BOB, { x: 0, y: 0, w: 2, h: 1 }, 1n, 10));
  const twisted = { ...w, actions: w.actions.map((a) => (a.key === "cell/1,0" ? { ...a, newValue: a.newValue.replace(" ad ", " ad2 ") } : a)) };
  assert.ok(!c.accepts(BOB, twisted));
  const extra = { ...w, actions: [...w.actions, { key: "cell/5,5", newValue: w.actions[0].newValue }] };
  assert.ok(!c.accepts(BOB, extra));
  const spelled = { ...w, actions: [...w.actions, { key: "cell/05,5", newValue: "x" }] };
  assert.ok(!c.accepts(BOB, spelled));
});

test("covering part of a post takes it down whole and pays it back for what it had left", () => {
  const c = owned();
  assert.ok(c.send(BOB, write(c, terms(c, BOB, { x: 0, y: 0, w: 4, h: 4 }, 2n, 1000))));
  c.advance(400);
  // Carol covers 4 of Bob's 16 cells; Bob's whole post pays 32 per block.
  const t = terms(c, CAROL, { x: 3, y: 3, w: 2, h: 2 }, 8n, 500);
  const q = quote(c, t);
  assert.equal(q.replaces, 32n + 3n); // Bob's post, plus 3 empty cells at 1
  assert.equal(q.minRate, 9n);
  assert.equal(q.cleared, 15);
  assert.ok(!q.enough);
  const w = write(c, { ...t, rate: 9n });
  assert.deepEqual(w.payments, [
    { to: OWNER, amount: 9n * 500n * 4n },
    { to: BOB, amount: 2n * 16n * 600n },
  ]);
  assert.ok(!c.accepts(CAROL, paying(w, BOB, 2n * 16n * 600n - 1n)), "pays back every cell and block Bob had left");
  assert.ok(!c.accepts(CAROL, without(w, "cell/0,0")), "Bob's corner is cleared too");
  assert.ok(!c.accepts(CAROL, without(w, "cell/1,2")), "every cell of Bob's post is cleared");
  assert.ok(c.send(CAROL, w));
  const after = c.board();
  assert.deepEqual(board.upPosts(after).map((p) => p.poster), [CAROL]);
  assert.equal(after.cells.size, 4);
});

test("a post over several posts pays at least all of them per block", () => {
  // The plan's worked example, on a board cut in two: O1 owns 0–1, O2 owns 2–3.
  const c = owned();
  const whole = c.board().parcels[0];
  assert.ok(c.send(OWNER, board.cutParcel(c.board(), whole, { axis: "x", at: 2 })));
  const right = c.board().parcels.find((p) => p.rect.x === 2);
  assert.ok(c.send(OWNER, board.setParcel(right, { owner: DAN })));
  assert.ok(c.send(BOB, write(c, terms(c, BOB, { x: 0, y: 0, w: 2, h: 1 }, 2n, 1000))));
  c.advance(100);
  assert.ok(c.send(CAROL, write(c, terms(c, CAROL, { x: 2, y: 0, w: 1, h: 1 }, 4n, 1000))));
  c.advance(300);
  const t = terms(c, DAN, { x: 1, y: 0, w: 3, h: 1 }, 2n, 500, "b");
  assert.equal(quote(c, t).replaces, 8n + 1n); // Bob 4 + Carol 4, one empty cell at 1
  assert.equal(quote(c, t).minRate, 3n);
  const w = write(c, { ...t, rate: 3n });
  // Dan owns two of the cells, so he pays himself nothing for them.
  assert.deepEqual(w.payments, [
    { to: OWNER, amount: 3n * 500n },
    { to: BOB, amount: 4n * 600n },
    { to: CAROL, amount: 4n * 700n },
  ]);
  assert.ok(!c.accepts(DAN, without(w, "parcel/2,0,30,18")), "names every parcel under it");
  assert.ok(c.send(DAN, w));
});

test("an ended post is empty space: no payback, the owner's minimum applies", () => {
  const c = owned(2n);
  assert.ok(c.send(BOB, write(c, terms(c, BOB, { x: 0, y: 0, w: 2, h: 2 }, 5n, 10))));
  c.advance(10);
  const t = terms(c, CAROL, { x: 1, y: 1, w: 2, h: 2 }, 2n, 10);
  const q = quote(c, t);
  assert.equal(q.down.length, 0);
  assert.equal(q.replaces, 8n);
  assert.ok(c.send(CAROL, write(c, t)));
  // Bob's three other cells stay as they were, ended; anyone may clear them.
  assert.ok(c.send(DAN, { actions: [{ key: "cell/0,0", oldValue: c.board().cells.get("cell/0,0") }] }));
});

test("a poster takes down their own post whole; nobody else takes one down without posting", () => {
  const c = owned();
  assert.ok(c.send(BOB, write(c, terms(c, BOB, { x: 0, y: 0, w: 2, h: 1 }, 1n, 100))));
  const [up] = board.upPosts(c.board());
  assert.ok(!c.accepts(CAROL, board.takeDown(up)));
  assert.ok(!c.accepts(BOB, without(board.takeDown(up), "cell/1,0")));
  const forged = { actions: [{ key: "cell/0,0", oldValue: up.value, newValue: up.value.replace(BOB, CAROL) }, { key: "cell/1,0", oldValue: up.value }] };
  assert.ok(!c.accepts(CAROL, forged));
  assert.ok(c.send(BOB, board.takeDown(up)));
});

test("an owner sets terms; anyone buys a parcel at its asking price", () => {
  const c = owned();
  const [whole] = c.board().parcels;
  assert.ok(!c.accepts(BOB, board.setParcel(whole, { owner: BOB })), "not for sale");
  assert.ok(c.send(OWNER, board.setParcel(whole, { ask: 5000n, min: 4n })));
  const [listed] = c.board().parcels;
  const buy = board.buyParcel(listed, BOB);
  assert.deepEqual(buy.payments, [{ to: OWNER, amount: 5000n }]);
  assert.ok(!c.accepts(BOB, paying(buy, OWNER, 4999n)));
  assert.ok(c.send(BOB, buy));
  const [bought] = c.board().parcels;
  assert.equal(bought.owner, BOB);
  assert.equal(bought.ask, null);
  assert.ok(!c.accepts(OWNER, board.setParcel(bought, { owner: OWNER })));
  assert.ok(!c.accepts(BOB, { actions: [{ key: bought.key, oldValue: bought.value }] }), "never deleted");
});

test("an owner cuts and joins parcels, covering the same cells", () => {
  const c = owned();
  const [whole] = c.board().parcels;
  const cut = board.cutParcel(c.board(), whole, { axis: "y", at: 6 });
  assert.ok(!c.accepts(BOB, cut));
  const overlapping = { actions: [cut.actions[0], cut.actions[1], { key: "parcel/0,5,32,13", newValue: `${OWNER} 1` }] };
  assert.ok(!c.accepts(OWNER, overlapping));
  assert.ok(!c.accepts(OWNER, { actions: cut.actions.slice(0, 2) }), "every cell stays in a parcel");
  assert.ok(c.send(OWNER, cut));
  const [top, bottom] = c.board().parcels;
  assert.ok(c.send(OWNER, board.setParcel(bottom, { owner: BOB })));
  // Joining needs both owners' signatures, so Bob gives it back first.
  const back = c.board().parcels.find((p) => p.owner === BOB);
  assert.ok(c.send(BOB, board.setParcel(back, { owner: OWNER })));
  const parts = c.board().parcels;
  const join = {
    actions: [
      ...parts.map((p) => ({ key: p.key, oldValue: p.value, newValue: "-" })),
      { key: whole.key, oldValue: "-", newValue: `${OWNER} 1` },
    ],
  };
  assert.ok(c.send(OWNER, join));
  assert.deepEqual(c.board().parcels.map((p) => p.key), [whole.key]);
  assert.ok(top && bottom);
  // A cut-away parcel cannot come back without its cells.
  const stale = c.board();
  assert.ok(!c.accepts(OWNER, { actions: [{ key: top.key, oldValue: "-", newValue: `${OWNER} 1` }] }));
  assert.ok(stale);
});

test("account records are their owner's; other keys are refused", () => {
  const c = owned();
  assert.ok(c.accepts(BOB, { actions: [{ key: board.postKey(BOB, "ad"), newValue: "{}" }] }));
  assert.ok(c.accepts(BOB, { actions: [{ key: `user/${BOB}/label/${CAROL}/ad`, newValue: "spam" }] }));
  assert.ok(!c.accepts(BOB, { actions: [{ key: board.postKey(CAROL, "ad"), newValue: "{}" }] }));
  for (const key of ["post/x", "cell", "cell/32,0", "cell/0,18", "parcel/0,0,0,1", "board", "users/x"]) {
    assert.ok(!c.accepts(BOB, { actions: [{ key, newValue: "x" }] }), key);
  }
});

test("a full-board post over a full-board post", () => {
  const c = owned();
  assert.ok(c.send(BOB, write(c, terms(c, BOB, board.BOARD, 1n, 100))));
  c.advance(10);
  const w = write(c, terms(c, CAROL, board.BOARD, 1n, 100));
  assert.equal(w.actions.length, 576 + 2);
  assert.ok(c.send(CAROL, w));
});

test("a full-board post on a board cut into single cells", () => {
  const c = owned();
  const [whole] = c.board().parcels;
  const singles = [...board.cellsOf(board.BOARD)].map(([x, y]) => ({ key: board.parcelKey({ x, y, w: 1, h: 1 }), newValue: `${OWNER} 1` }));
  assert.ok(c.send(OWNER, { actions: [{ key: whole.key, oldValue: whole.value, newValue: "-" }, ...singles] }));
  assert.equal(c.board().parcels.length, 576);
  const w = write(c, terms(c, BOB, board.BOARD, 1n, 10));
  assert.equal(w.actions.length, 576 * 2 + 1);
  assert.ok(c.send(BOB, w));
});
