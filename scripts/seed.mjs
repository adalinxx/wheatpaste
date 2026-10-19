// Seeds a trial board with example ads from example accounts, so the page
// has something real to show: the operator key cuts the board in three,
// gives one part away and lists one for sale, funds the accounts, and each
// account posts an ad drawn here as a poster. Every write waits for its block.
//
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js PLAYWRIGHT=<playwright>/index.mjs \
//     node scripts/seed.mjs <key.json> <node URL> <chain path> <accounts directory>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as board from "../client/board.mjs";
import { list, volumeLoader } from "../client/state.mjs";
import * as wallet from "../client/wallet.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const { chromium } = await import(process.env.PLAYWRIGHT);
const [keyFile, node, chain, accountsDir] = process.argv.slice(2);
const chainPath = chain.split("/");
const operator = JSON.parse(readFileSync(keyFile, "utf8"));

function account(name) {
  const file = `${accountsDir}/seed-${name}.json`;
  if (!existsSync(file)) {
    const a = sdk.accountFromPrivateKey(sdk.generatePrivateKey());
    const hex = (b) => (typeof b === "string" ? b : Buffer.from(b).toString("hex"));
    writeFileSync(file, JSON.stringify({ address: a.address, privateKey: hex(a.privateKey) }), { mode: 0o600 });
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

async function api(path) {
  const url = new URL(path, node);
  url.searchParams.set("chainPath", chain);
  const response = await fetch(url, { cache: "no-store" });
  return response.ok ? response.json() : undefined;
}

const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath }));
const load = volumeLoader(volumes, sdk.decodeDagCbor);
async function read() {
  const tip = await api("/api/block/latest");
  const block = sdk.decodeCanonicalBlock((await volumes.get(tip.hash)).rootBytes());
  const state = sdk.decodeCanonicalLatticeState((await volumes.get(block.postStateCID)).rootBytes());
  const entries = [];
  for (const prefix of ["parcel/", "cell/"]) for await (const e of list(load, state.generalStateCID, prefix)) entries.push(e);
  return board.readBoard(entries, tip.height);
}

async function send(who, write, label, landed) {
  const { nonce } = (await api(`/api/state/account/${who.address}`)) ?? { nonce: 0 };
  const body = wallet.transaction({ owner: who.address, ...write, fee: 0n, nonce: BigInt(nonce ?? 0), chainPath });
  const { publicKey, signature } = sdk.signTransactionBody(body, Uint8Array.from(Buffer.from(who.privateKey, "hex")));
  const response = await fetch(new URL("/transactions", node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${label}: ${response.status} ${text}`);
  console.log(`sent: ${label}`);
  for (let i = 0; ; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      if (await landed(await read())) break;
    } catch {}
    if (i > 120) throw new Error(`${label}: not mined after 10 minutes`);
  }
  console.log(`landed: ${label}`);
}

// The posters, drawn as HTML and photographed at 40 px a square.
const ADS = [
  { name: "bikes", rect: { x: 1, y: 1, w: 9, h: 6 }, hours: 72, caption: "Northline Bikes: spring tune-ups, walk in", link: "https://example.com/northline",
    html: `<div style="background:#1d3b8b;color:#f2f5ff;height:100%;display:grid;align-content:center;padding:0 34px;font-family:'Arial Narrow',Impact,sans-serif"><div style="font-size:30px;letter-spacing:.2em;opacity:.8">SPRING</div><div style="font-size:92px;font-weight:900;line-height:.85">TUNE-UPS</div><div style="font-size:26px;margin-top:14px;font-family:Helvetica,sans-serif">Northline Bikes · walk in, ride out</div><div style="position:absolute;right:30px;top:24px;width:90px;height:90px;border-radius:50%;border:6px solid #ffd23f"></div></div>` },
  { name: "records", rect: { x: 11, y: 1, w: 6, h: 6 }, hours: 48, caption: "Kiln Records: vinyl, Friday to Sunday", link: "https://example.com/kiln",
    html: `<div style="background:#c2410c;color:#fff4ec;height:100%;display:grid;place-items:center;font-family:Georgia,serif;text-align:center"><div><div style="width:150px;height:150px;border-radius:50%;background:radial-gradient(circle,#c2410c 0 14px,#111 15px 100%);margin:0 auto 14px;box-shadow:0 0 0 4px #fff4ec"></div><div style="font-size:44px;font-weight:700">Kiln Records</div><div style="font-size:20px;letter-spacing:.15em">VINYL · FRI–SUN</div></div></div>` },
  { name: "coffee", rect: { x: 18, y: 2, w: 8, h: 4 }, hours: 24, caption: "Halcyon Coffee, roasted on the corner", link: "https://example.com/halcyon",
    html: `<div style="background:#efe6d2;color:#2a1d12;height:100%;display:flex;align-items:center;gap:26px;padding:0 30px;font-family:Helvetica,sans-serif"><div style="font-size:84px">☕</div><div><div style="font-size:54px;font-weight:800;letter-spacing:-.02em">Halcyon</div><div style="font-size:22px">Roasted on the corner of 4th & Elm</div></div></div>` },
  { name: "hiring", rect: { x: 4, y: 12, w: 12, h: 3 }, hours: 168, caption: "Parallax Labs is hiring engineers", link: "https://example.com/parallax",
    html: `<div style="background:#0f0f10;color:#e9e9ea;height:100%;display:flex;align-items:center;justify-content:space-between;padding:0 30px;font-family:'Courier New',monospace"><div style="font-size:40px">parallax<span style="color:#7cf29a">_</span>labs</div><div style="font-size:26px;border:2px solid #7cf29a;color:#7cf29a;padding:8px 16px">we're hiring →</div></div>` },
  { name: "cat", rect: { x: 27, y: 9, w: 4, h: 5 }, hours: 24, caption: "Lost cat: Miso, orange, answers to snacks", link: "https://example.com/miso",
    html: `<div style="background:#fffef6;color:#111;height:100%;display:grid;align-content:center;justify-items:center;font-family:Helvetica,sans-serif;text-align:center;padding:10px"><div style="font-size:40px;font-weight:900;color:#d0021b">LOST CAT</div><div style="font-size:70px">🐈</div><div style="font-size:24px;font-weight:700">MISO</div><div style="font-size:15px">orange · answers to snacks</div></div>` },
  { name: "openmic", rect: { x: 19, y: 9, w: 6, h: 7 }, hours: 72, caption: "Open mic, Thursdays at The Annex", link: "https://example.com/annex",
    html: `<div style="background:#ffd23f;color:#16181b;height:100%;display:grid;align-content:space-between;padding:26px;font-family:'Arial Narrow',Impact,sans-serif"><div style="font-size:24px;letter-spacing:.2em">THE ANNEX</div><div style="font-size:88px;font-weight:900;line-height:.85">OPEN<br>MIC</div><div style="font-size:28px">THURSDAYS · 8 PM</div></div>` },
];

const page = await (await chromium.launch()).newPage();
async function poster(ad) {
  await page.setViewportSize({ width: ad.rect.w * 40, height: ad.rect.h * 40 });
  await page.setContent(`<html><body style="margin:0;position:relative;width:100vw;height:100vh">${ad.html}</body></html>`);
  return `data:image/jpeg;base64,${(await page.screenshot({ type: "jpeg", quality: 82 })).toString("base64")}`;
}

let b = await read();
if (b.parcels.length === 0) {
  await send(operator, board.claimBoard(operator.address, 1n), "claim the board", async (x) => x.parcels.length === 1);
  b = await read();
}
const giftee = account("owner");
if (b.parcels.length === 1) {
  await send(operator, board.cutParcel(b, b.parcels[0], { axis: "x", at: 18 }), "cut the board at column 18", async (x) => x.parcels.length === 2);
  b = await read();
  const right = b.parcels.find((p) => p.rect.x === 18);
  await send(operator, board.cutParcel(b, right, { axis: "y", at: 8 }), "cut the right part at row 8", async (x) => x.parcels.length === 3);
  b = await read();
  const top = b.parcels.find((p) => p.rect.x === 18 && p.rect.y === 0);
  await send(operator, board.setParcel(top, { owner: giftee.address, min: 2n }), "give the top right to another owner", async (x) => x.parcels.some((p) => p.owner === giftee.address));
  b = await read();
  const bottom = b.parcels.find((p) => p.rect.x === 18 && p.rect.y === 8);
  await send(operator, board.setParcel(bottom, { ask: 250_000n }), "list the bottom right for sale", async (x) => x.parcels.some((p) => p.ask === 250_000n));
}
for (const ad of ADS) {
  b = await read();
  if (board.upPosts(b).some((p) => p.id === ad.name)) continue;
  const who = account(ad.name);
  const { balance } = (await api(`/api/state/account/${who.address}`)) ?? { balance: 0 };
  const recent = (await api("/api/blocks?limit=30")).blocks.map((x) => Number(x.timestamp));
  const perHour = BigInt(Math.round(3_600_000 / ((Math.max(...recent) - Math.min(...recent)) / (recent.length - 1))));
  const terms = { poster: who.address, id: ad.name, rect: ad.rect, rate: 0n, start: b.height, end: b.height + perHour * BigInt(ad.hours) };
  terms.rate = board.quotePost(b, terms).minRate + (ad.name === "openmic" ? 1n : 0n);
  const write = board.post(b, terms, { image: await poster(ad), caption: ad.caption, link: ad.link });
  const cost = write.payments.reduce((n, p) => n + p.amount, 0n);
  if (BigInt(balance ?? 0) < cost) {
    await send(operator, { actions: [], payments: [{ to: who.address, amount: cost * 2n }] }, `fund ${ad.name}`, async () => BigInt((await api(`/api/state/account/${who.address}`))?.balance ?? 0) >= cost);
  }
  await send(who, write, `post ${ad.name}`, async (x) => board.upPosts(x).some((p) => p.id === ad.name));
}
console.log("seeded");
process.exit(0);
