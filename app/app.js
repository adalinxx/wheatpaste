// Wheatpaste: one shared billboard, read from its chain by CID and written
// through the Selfhold wallet, which asks for every payment. Reading needs
// no wallet.
import * as sdk from "../client/lattice-sdk.js";
import * as board from "../client/board.mjs";
import { anyHost, chainSpec, get, list, volumeLoader } from "../client/state.mjs";
import { writeRequest } from "../client/wallet.mjs";

// ---------------------------------------------------------------- settings

const params = new URLSearchParams(location.search);
const NODES = (params.get("nodes") ?? "https://lattice-testnet-apps-iad.fly.dev,https://lattice-testnet-apps-ams.fly.dev").split(",");
const CHAIN = (params.get("chain") ?? "Nexus/testnet/wheatpaste-acbbcf").split("/");
// The trial chain's hosts admit 0-fee writes.
const FEE = 0n;
const WALLET_URL = "https://chromewebstore.google.com/detail/amcobhbipbblfjonmoiicihhfglkhpce";
const phone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const DURATIONS = [["1 hour", 1], ["6 hours", 6], ["1 day", 24], ["1 week", 168]];
// Each square of an image is kept at this many pixels a side.
const SQUARE_PX = 40;
const MAX_IMAGE_BYTES = 300_000;
const IMAGE = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/;

// ---------------------------------------------------------------- reading

const transport = anyHost(NODES.map((node) => new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: CHAIN })));
const volumes = new sdk.VolumeClient(transport);
const load = volumeLoader(volumes, sdk.decodeDagCbor);

/** What the page shows: the board at the latest tip, and each post's content. */
const live = { hash: null, height: 0n, board: null, content: new Map(), blockMs: 10_000, root: null };

async function latest() {
  let failure;
  for (const node of NODES) {
    try {
      const url = new URL("/api/block/latest", node);
      url.searchParams.set("chainPath", CHAIN.join("/"));
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

/** How long a block takes lately: the mean gap over the last blocks. Times and hourly prices use it. */
async function blockTime() {
  const url = new URL("/api/blocks", NODES[0]);
  url.searchParams.set("chainPath", CHAIN.join("/"));
  url.searchParams.set("limit", "30");
  const { blocks } = await (await fetch(url, { cache: "no-store" })).json();
  const times = blocks.map((b) => Number(b.timestamp));
  return times.length > 2 ? (Math.max(...times) - Math.min(...times)) / (times.length - 1) : null;
}

async function refresh() {
  const tip = await latest();
  if (tip.hash === live.hash) return false;
  const block = sdk.decodeCanonicalBlock((await volumes.get(tip.hash)).rootBytes());
  const state = sdk.decodeCanonicalLatticeState((await volumes.get(block.postStateCID)).rootBytes());
  if (!live.spec) {
    live.spec = await chainSpec(sdk, volumes, block.specCID);
    live.blockMs = Number(live.spec.targetBlockTime ?? 10_000);
  }
  live.blockMs = (await blockTime().catch(() => null)) ?? live.blockMs;
  const root = state.generalStateCID;
  const entries = [];
  for (const prefix of ["parcel/", "cell/"]) for await (const entry of list(load, root, prefix)) entries.push(entry);
  const next = board.readBoard(entries, tip.height);
  await Promise.all(board.upPosts(next).map(async (post) => {
    const key = board.postKey(post.poster, post.id);
    if (live.content.has(key) && live.content.get(key).root === root) return;
    live.content.set(key, { root, ...readContent(await get(load, root, key).catch(() => undefined)) });
  }));
  Object.assign(live, { hash: tip.hash, height: BigInt(tip.height), board: next, root });
  return true;
}

/** A post's content as stored, keeping only what this page shows. */
function readContent(text) {
  let raw;
  try {
    raw = JSON.parse(text ?? "{}");
  } catch {
    return {};
  }
  const out = {};
  if (typeof raw.image === "string" && IMAGE.test(raw.image)) out.image = raw.image;
  if (typeof raw.link === "string" && safeLink(raw.link)) out.link = raw.link;
  if (typeof raw.caption === "string") out.caption = raw.caption.slice(0, 140);
  return out;
}

function safeLink(text) {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

const contentOf = (post) => live.content.get(board.postKey(post.poster, post.id)) ?? {};

// ---------------------------------------------------------------- time and money

const blocksPerHour = () => BigInt(Math.round(3_600_000 / live.blockMs));
const perHour = (rate, squares) => rate * BigInt(squares) * blocksPerHour();
const fmt = (n) => BigInt(n).toLocaleString("en-US");

function whenBlock(height) {
  const at = new Date(Date.now() + Number(BigInt(height) - live.height) * live.blockMs);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const days = Math.round((startOfDay(at) - startOfDay(new Date())) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const short = (address) => `${address.slice(0, 10)}…${address.slice(-4)}`;
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------------------------------------------------------------- wallet

const wallet = () => window.lattice ?? null;
let account = null;

async function connect() {
  if (!wallet()) throw new Error("This needs Selfhold, the wallet for Lattice.");
  account = await wallet().connect();
  return account;
}

function walletMessage(error) {
  const text = String(error?.message ?? error);
  if (/just declined|ask again in a moment/i.test(text)) return "The wallet waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied/i.test(text)) return "You declined it in the wallet. Nothing was sent.";
  if (/locked/i.test(text)) return "Unlock Selfhold, then try again.";
  if (/at most 16/i.test(text)) return "That pays more than 16 people in one approval. Pick a smaller area.";
  return text;
}

/** Sends a write, then waits until the board shows it (`landed()`). */
async function act(label, build, landed) {
  const note = toast(`${label}: approve it in your wallet.`);
  try {
    if (!account) await connect();
    const write = await build();
    await wallet().writeRecords(writeRequest(CHAIN, write, FEE));
    note.update(`${label}: waiting for the next block…`);
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if ((await refresh().catch(() => false)) && landed()) break;
      if (Date.now() > deadline) throw new Error("Sent, but no block has shown it yet. It may still land.");
    }
    note.update(`${label}: done.`);
    setTimeout(note.close, 2500);
    return true;
  } catch (error) {
    note.update(walletMessage(error), { bad: true });
    return false;
  } finally {
    render();
  }
}

// ---------------------------------------------------------------- page state

const ui = {
  owners: false,
  selected: null, // { kind: "ad", value } | { kind: "space", rect } | { kind: "parcel", key }
  draft: { file: null, image: null, link: "", caption: "", hours: 24, rate: null },
  cut: null, // { axis, at } while splitting a parcel
};
let hidden = new Set();
try {
  hidden = new Set(JSON.parse(localStorage.getItem("wheatpaste.hidden") ?? "[]"));
} catch {}
function setHidden(value, on) {
  if (on) hidden.add(value);
  else hidden.delete(value);
  try {
    localStorage.setItem("wheatpaste.hidden", JSON.stringify([...hidden]));
  } catch {}
}

const $ = (selector) => document.querySelector(selector);
function place(el, r) {
  Object.assign(el.style, { left: `${(r.x / board.WIDTH) * 100}%`, top: `${(r.y / board.HEIGHT) * 100}%`, width: `${(r.w / board.WIDTH) * 100}%`, height: `${(r.h / board.HEIGHT) * 100}%` });
  return el;
}
const div = (className, html = "") => Object.assign(document.createElement("div"), { className, innerHTML: html });

// ---------------------------------------------------------------- the board

function quote() {
  const s = ui.selected;
  if (s?.kind !== "space" || !live.board) return null;
  const base = { poster: account ?? "x".repeat(59), id: "draft", rect: s.rect, start: live.height, end: live.height + BigInt(ui.draft.hours) * blocksPerHour() };
  const least = board.quotePost(live.board, { ...base, rate: 0n }).minRate;
  if (ui.draft.rate === null || ui.draft.rate < least) ui.draft.rate = least;
  return { ...board.quotePost(live.board, { ...base, rate: ui.draft.rate }), least, terms: { ...base, rate: ui.draft.rate } };
}

function renderBoard(q) {
  const el = $("#board");
  el.className = `board${ui.owners ? "" : " drawing"}`;
  el.replaceChildren();
  if (!live.board) return;
  const down = new Set(q?.down.map((p) => p.value) ?? []);
  for (const post of board.upPosts(live.board)) {
    const content = contentOf(post);
    const ad = div(`ad${down.has(post.value) ? " down" : ""}${hidden.has(post.value) ? " hidden" : ""}`);
    ad.dataset.value = post.value;
    ad.innerHTML = content.image ? `<img alt="${esc(content.caption ?? "")}" src="${content.image}">` : `<div class="blank">${post.rect.w > 3 ? "No image" : ""}</div>`;
    ad.title = [content.caption, content.link && safeLink(content.link)?.host].filter(Boolean).join(" · ");
    el.append(place(ad, post.rect));
  }
  if (ui.selected?.kind === "space") {
    const pick = div("pick", ui.draft.image ? `<img alt="" src="${ui.draft.image}">` : "");
    el.append(place(pick, ui.selected.rect));
  }
  if (ui.owners) {
    for (const parcel of live.board.parcels) {
      const on = ui.selected?.kind === "parcel" && ui.selected.key === parcel.key;
      const p = div(`parcel${parcel.owner === account ? " mine" : ""}${on ? " on" : ""}`, `<span>${parcel.ask == null ? short(parcel.owner) : `For sale · ${fmt(parcel.ask)}`}</span>`);
      p.dataset.key = parcel.key;
      el.append(place(p, parcel.rect));
    }
    const parcel = selectedParcel();
    if (parcel && ui.cut) {
      const r = parcel.rect;
      const line = ui.cut.axis === "x" ? { x: r.x + ui.cut.at, y: r.y, w: 0, h: r.h } : { x: r.x, y: r.y + ui.cut.at, w: r.w, h: 0 };
      const cut = place(div("cutline"), line);
      Object.assign(cut.style, ui.cut.axis === "x" ? { width: "3px", marginLeft: "-1.5px" } : { height: "3px", marginTop: "-1.5px" });
      el.append(cut);
    }
  }
}

const selectedParcel = () => (ui.selected?.kind === "parcel" ? live.board?.parcels.find((p) => p.key === ui.selected.key) : undefined);
const selectedAd = () => (ui.selected?.kind === "ad" ? board.upPosts(live.board).find((p) => p.value === ui.selected.value) : undefined);

function renderStatus() {
  const s = $("#status");
  if (!live.board) return;
  const up = board.upPosts(live.board);
  const free = board.WIDTH * board.HEIGHT - up.reduce((n, p) => n + board.area(p.rect), 0);
  s.textContent = live.board.parcels.length === 0
    ? "Nobody has claimed this board yet."
    : phone
      ? `${up.length} ${up.length === 1 ? "ad" : "ads"} · ${free} squares free. Tap an ad to see it.`
      : `${up.length} ${up.length === 1 ? "ad" : "ads"} · ${free} squares free. Drag across the board to post your own, anywhere, over anyone.`;
}

// ---------------------------------------------------------------- the panel

function renderPanel(q) {
  const panel = $("#panel");
  const s = ui.selected;
  panel.hidden = !s;
  if (!s || !live.board) return;
  if (s.kind === "space") panel.innerHTML = spacePanel(q);
  else if (s.kind === "ad") panel.innerHTML = adPanel(selectedAd());
  else panel.innerHTML = parcelPanel(selectedParcel());
}

const head = (title, sub = "") => `<div class="head"><div><h2>${title}</h2>${sub ? `<p class="muted">${sub}</p>` : ""}</div><button class="close" data-close aria-label="Close">×</button></div>`;

function spacePanel(q) {
  const { rect } = ui.selected;
  const d = ui.draft;
  const squares = board.area(rect);
  const owners = new Set(q.parcels.map((p) => p.owner));
  const space = q.payments.filter((p) => owners.has(p.to)).reduce((n, p) => n + p.amount, 0n);
  const back = q.cost - space;
  const downNote = q.down.length
    ? `<p class="down-note">Covers ${q.down.length === 1 ? "an ad" : `${q.down.length} ads`}. ${q.down.length === 1 ? "It comes" : "They come"} down whole when yours goes up, and you pay ${q.down.length === 1 ? "it" : "them"} back for unused time.</p>`
    : "";
  const action = !wallet()
    ? phone
      ? `<p class="muted">Posting works on a computer, with the Selfhold wallet.</p>`
      : `<p class="muted">Posting needs Selfhold, the wallet for Lattice. Add it, then come back to this tab.</p><a class="go" style="text-align:center;text-decoration:none" href="${WALLET_URL}" target="_blank" rel="noopener">Add Selfhold</a>`
    : `<button class="go" data-post ${d.image ? "" : "disabled"}>${d.image ? `Post for ${fmt(q.cost)}` : "Add an image to post"}</button>`;
  return `
    ${head("Post here", `${rect.w} × ${rect.h} squares`)}
    ${downNote}
    <label class="drop${d.image ? " has" : ""}" for="file">
      <strong>${d.image ? "Change image" : "Add your image"}</strong>
      <span class="muted">${d.image ? "It fills the squares you picked." : `Cropped to fit ${rect.w} × ${rect.h}. PNG, JPEG or WebP.`}</span>
    </label>
    <input id="file" type="file" accept="image/png,image/jpeg,image/webp" hidden>
    <div class="field"><label for="link">Link, optional</label><input id="link" type="url" placeholder="https://" value="${esc(d.link)}"></div>
    <div class="field"><label for="caption">Caption, shown on hover</label><input id="caption" maxlength="140" value="${esc(d.caption)}"></div>
    <div class="field"><span class="label">How long</span>
      <div class="choice">${DURATIONS.map(([label, hours]) => `<button data-hours="${hours}" aria-pressed="${d.hours === hours}">${label}</button>`).join("")}</div>
    </div>
    <div class="field"><span class="label">Price per hour</span>
      <div class="stepper"><button data-rate="-1" aria-label="Lower" ${d.rate <= q.least ? "disabled" : ""}>−</button><output>${fmt(perHour(d.rate, squares))}</output><button data-rate="1" aria-label="Raise">+</button></div>
      <p class="muted">${q.least > 0n ? `The least for this space is ${fmt(perHour(q.least, squares))} an hour.` : "This space is free right now."} To cover your ad, someone must pay at least what you pay.</p>
    </div>
    <div class="lines">
      <div><span>Space, paid to ${owners.size === 1 ? "its owner" : `${owners.size} owners`}</span><span>${fmt(space)}</span></div>
      ${q.down.length ? `<div><span>Paid back to covered ads</span><span>${fmt(back)}</span></div>` : ""}
      <div class="total"><span>Total</span><span>${fmt(q.cost)}</span></div>
      <p class="muted">Ends ${whenBlock(q.terms.end)}.</p>
    </div>
    ${action}`;
}

function adPanel(post) {
  if (!post) return head("This ad is gone");
  const c = contentOf(post);
  const link = c.link && safeLink(c.link);
  const squares = board.area(post.rect);
  const isHidden = hidden.has(post.value);
  return `
    ${head(c.caption ? esc(c.caption) : "An ad", `${post.rect.w} × ${post.rect.h} squares · by ${short(post.poster)}`)}
    ${c.image && !isHidden ? `<img class="preview" alt="" src="${c.image}">` : ""}
    ${link ? `<a class="go" style="text-align:center;text-decoration:none" href="${esc(link.href)}" target="_blank" rel="noopener nofollow">Visit ${esc(link.host)} ↗</a>` : ""}
    <div class="lines">
      <div><span>Up until</span><span>${whenBlock(post.end)}</span></div>
      <div><span>Pays</span><span>${fmt(perHour(post.rate, squares))} / hour</span></div>
    </div>
    <div class="row">
      ${phone ? "" : `<button class="quiet" data-cover>Post over this</button>`}
      <button class="quiet" data-hide>${isHidden ? "Show it" : "Hide it for me"}</button>
    </div>`;
}

function parcelPanel(parcel) {
  if (!parcel) return head("This space changed hands");
  const mine = parcel.owner === account;
  const squares = board.area(parcel.rect);
  const earning = board.upPosts(live.board).reduce((n, p) => {
    let inside = 0;
    for (const [x, y] of board.cellsOf(p.rect)) if (board.inside(parcel.rect, x, y)) inside++;
    return n + perHour(p.rate, inside);
  }, 0n);
  const facts = `
    <div class="lines">
      <div><span>Size</span><span>${parcel.rect.w} × ${parcel.rect.h}</span></div>
      <div><span>Empty squares cost</span><span>${fmt(perHour(parcel.min, 1))} / hour each</span></div>
      <div><span>Earning now</span><span>${fmt(earning)} / hour</span></div>
      <div><span>For sale</span><span>${parcel.ask == null ? "No" : fmt(parcel.ask)}</span></div>
    </div>`;
  if (!mine) {
    return `
      ${head(`${squares} squares`, `Owned by ${short(parcel.owner)}`)}
      ${facts}
      ${parcel.ask != null ? (wallet() ? `<button class="go" data-buy>Buy for ${fmt(parcel.ask)}</button>` : `<p class="muted">Buying needs Selfhold, the wallet for Lattice.</p>`) : ""}
      <p class="muted">The owner is paid by every ad posted on these squares. Ads already up stay up when it sells.</p>
      ${wallet() && !account ? `<button class="quiet" data-whoami>This is mine</button>` : ""}`;
  }
  const cut = ui.cut;
  const span = cut ? (cut.axis === "x" ? parcel.rect.w : parcel.rect.h) : 0;
  return `
    ${head(`Your ${squares} squares`, "You own this space")}
    ${facts}
    <div class="field"><label for="min">Empty squares, per hour each</label>
      <div class="stepper"><button data-min="-1" aria-label="Lower" ${parcel.min === 0n ? "disabled" : ""}>−</button><output id="min">${fmt(perHour(ui.min ?? parcel.min, 1))}</output><button data-min="1" aria-label="Raise">+</button></div></div>
    <div class="field"><label for="ask">Sell it for, empty for not for sale</label><input id="ask" inputmode="numeric" value="${parcel.ask ?? ""}"></div>
    <button class="go" data-save>Save</button>
    <div class="field"><span class="label">Split it</span>
      ${cut
        ? `<input id="cut" type="range" min="1" max="${span - 1}" value="${cut.at}"><div class="row"><button class="quiet" data-split>Split here</button><button class="quiet" data-cut-cancel>Cancel</button></div>`
        : `<div class="row">${parcel.rect.w > 1 ? `<button class="quiet" data-cut="x">Side by side</button>` : ""}${parcel.rect.h > 1 ? `<button class="quiet" data-cut="y">Top and bottom</button>` : ""}</div>`}
    </div>`;
}

// ---------------------------------------------------------------- rendering

function render() {
  const q = quote();
  renderBoard(q);
  renderPanel(q);
  renderStatus();
  $("#owners").setAttribute("aria-pressed", ui.owners);
}

function select(next) {
  ui.selected = next;
  ui.cut = null;
  ui.min = undefined;
  render();
}

// ---------------------------------------------------------------- input

function cellAt(event) {
  const r = $("#board").getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(board.WIDTH - 1, Math.floor(((event.clientX - r.left) / r.width) * board.WIDTH))),
    y: Math.max(0, Math.min(board.HEIGHT - 1, Math.floor(((event.clientY - r.top) / r.height) * board.HEIGHT))),
  };
}

let drag = null;
$("#board").addEventListener("pointerdown", (event) => {
  if (!live.board) return;
  const target = event.target.closest(".ad, .parcel");
  if (ui.owners) {
    if (target?.dataset.key) select({ kind: "parcel", key: target.dataset.key });
    return;
  }
  drag = { from: cellAt(event), moved: false, ad: target?.dataset.value };
  if (!phone) $("#board").setPointerCapture(event.pointerId);
});
$("#board").addEventListener("pointermove", (event) => {
  if (!drag || phone) return;
  const to = cellAt(event);
  if (!drag.moved && to.x === drag.from.x && to.y === drag.from.y) return;
  drag.moved = true;
  const rect = { x: Math.min(drag.from.x, to.x), y: Math.min(drag.from.y, to.y), w: Math.abs(to.x - drag.from.x) + 1, h: Math.abs(to.y - drag.from.y) + 1 };
  ui.selected = { kind: "space", rect };
  renderBoard(quote());
});
$("#board").addEventListener("pointerup", async () => {
  if (!drag) return;
  const { moved, ad, from } = drag;
  drag = null;
  if (moved) return pickSpace(ui.selected.rect);
  if (ad) return select({ kind: "ad", value: ad });
  if (!phone) pickSpace({ ...from, w: 1, h: 1 });
});

async function pickSpace(rect) {
  ui.selected = { kind: "space", rect };
  ui.draft.rate = null;
  if (ui.draft.file) ui.draft.image = await fitImage(ui.draft.file, rect).catch(() => null);
  render();
}

$("#owners").addEventListener("click", () => {
  ui.owners = !ui.owners;
  select(null);
});

$("#panel").addEventListener("click", async (event) => {
  const t = event.target.closest("button");
  if (!t) return;
  const q = quote();
  if (t.matches("[data-close]")) return select(null);
  if (t.dataset.hours) {
    ui.draft.hours = Number(t.dataset.hours);
    return render();
  }
  if (t.dataset.rate) {
    ui.draft.rate += BigInt(t.dataset.rate);
    return render();
  }
  if (t.matches("[data-post]")) return post(q);
  if (t.matches("[data-cover]")) return pickSpace(selectedAd().rect);
  if (t.matches("[data-hide]")) {
    const ad = selectedAd();
    setHidden(ad.value, !hidden.has(ad.value));
    return render();
  }
  if (t.matches("[data-whoami]")) {
    await connect().catch((error) => toast(walletMessage(error), { bad: true }));
    return render();
  }
  const parcel = selectedParcel();
  if (t.matches("[data-buy]")) {
    return act("Buying", async () => board.buyParcel(parcel, await connect()), () => live.board.parcels.some((p) => p.rect.x === parcel.rect.x && p.rect.y === parcel.rect.y && p.owner === account));
  }
  if (t.dataset.min) {
    ui.min = (ui.min ?? parcel.min) + BigInt(t.dataset.min);
    if (ui.min < 0n) ui.min = 0n;
    return render();
  }
  if (t.matches("[data-save]")) {
    const askText = $("#ask").value.trim().replaceAll(",", "");
    if (askText && !/^(0|[1-9][0-9]*)$/.test(askText)) return toast("Enter the price as a whole number, or leave it empty.", { bad: true });
    const terms = { min: ui.min ?? parcel.min, ask: askText ? BigInt(askText) : null };
    return act("Saving", () => board.setParcel(parcel, terms), () => live.board.parcels.some((p) => p.key === parcel.key && p.min === terms.min && p.ask === terms.ask));
  }
  if (t.dataset.cut) {
    const span = t.dataset.cut === "x" ? parcel.rect.w : parcel.rect.h;
    ui.cut = { axis: t.dataset.cut, at: Math.floor(span / 2) };
    return render();
  }
  if (t.matches("[data-cut-cancel]")) {
    ui.cut = null;
    return render();
  }
  if (t.matches("[data-split]")) {
    const cut = ui.cut;
    const done = await act("Splitting", () => board.cutParcel(live.board, parcel, cut), () => !live.board.parcels.some((p) => p.key === parcel.key));
    if (done) select(null);
  }
});

$("#panel").addEventListener("input", (event) => {
  const t = event.target;
  if (t.id === "link") ui.draft.link = t.value;
  if (t.id === "caption") ui.draft.caption = t.value;
  if (t.id === "cut") {
    ui.cut.at = Number(t.value);
    renderBoard(null);
  }
});

$("#panel").addEventListener("change", async (event) => {
  if (event.target.id !== "file") return;
  const file = event.target.files[0];
  if (!file) return;
  try {
    ui.draft.file = file;
    ui.draft.image = await fitImage(file, ui.selected.rect);
  } catch {
    ui.draft.file = null;
    toast("That image couldn't be read. Try a PNG, JPEG or WebP.", { bad: true });
  }
  render();
});

/** The image cropped to fill `rect`, at SQUARE_PX a square, as a data URL. */
async function fitImage(file, rect) {
  const bitmap = await createImageBitmap(file);
  const canvas = Object.assign(document.createElement("canvas"), { width: rect.w * SQUARE_PX, height: rect.h * SQUARE_PX });
  const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const [w, h] = [bitmap.width * scale, bitmap.height * scale];
  canvas.getContext("2d").drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  for (const quality of [0.86, 0.72, 0.58, 0.44, 0.3]) {
    const url = canvas.toDataURL("image/webp", quality);
    if (url.length * 0.75 <= MAX_IMAGE_BYTES) return url;
  }
  throw new Error("too large");
}

async function post(q) {
  const link = ui.draft.link.trim();
  if (link && !safeLink(link)) return toast("The link must start with https:// or http://.", { bad: true });
  const rect = ui.selected.rect;
  const id = Math.random().toString(36).slice(2, 10);
  let value;
  const done = await act(
    "Posting",
    async () => {
      const poster = await connect();
      // Priced again at the tip, as the wallet signs it.
      await refresh().catch(() => {});
      const terms = { poster, id, rect, rate: ui.draft.rate, start: live.height, end: live.height + BigInt(ui.draft.hours) * blocksPerHour() };
      const fresh = board.quotePost(live.board, terms);
      if (!fresh.enough) throw new Error(`The price here just went up: at least ${fmt(perHour(fresh.minRate, board.area(rect)))} an hour now.`);
      value = fresh.value;
      return board.post(live.board, terms, { image: ui.draft.image, ...(link && { link }), ...(ui.draft.caption.trim() && { caption: ui.draft.caption.trim() }) });
    },
    () => board.upPosts(live.board).some((p) => p.value === value),
  );
  if (done) {
    ui.draft = { file: null, image: null, link: "", caption: "", hours: ui.draft.hours, rate: null };
    select({ kind: "ad", value });
    toast("Your ad is up.");
  }
}

// ---------------------------------------------------------------- toast

function toast(text, { bad = false } = {}) {
  const el = $("#toast");
  el.hidden = false;
  const update = (next, options = {}) => {
    el.textContent = next;
    el.classList.toggle("bad", Boolean(options.bad));
    clearTimeout(el.timer);
    if (options.bad) el.timer = setTimeout(close, 6000);
  };
  const close = () => (el.hidden = true);
  update(text, { bad });
  if (!bad) el.timer = setTimeout(close, 4000);
  return { update, close };
}

// ---------------------------------------------------------------- start

async function tick() {
  try {
    if (await refresh()) render();
  } catch (error) {
    if (!live.board) $("#status").textContent = `The board isn't loading: no host is serving ${CHAIN.join("/")} right now.`;
  }
}
document.addEventListener("keydown", (event) => event.key === "Escape" && select(null));
await tick();
setInterval(tick, 5000);
