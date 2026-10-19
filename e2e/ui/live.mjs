// A post through the real Selfhold wallet on the live trial board: a new
// account, funded by the operator key, picks empty space on the page, adds an
// image, and approves the one payment in the wallet's own window, as a person
// would. The wallet keeps its default settings, so it finds the trial chain
// the way anyone's would.
//
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js PLAYWRIGHT=<playwright>/index.mjs \
//   LATTICE_WALLET=<nexus-wallet>/dist node e2e/ui/live.mjs <page URL> <operator key.json>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const sdk = await import(process.env.LATTICE_SDK);
const { chromium } = await import(process.env.PLAYWRIGHT);
const [pageURL, operatorKey] = process.argv.slice(2);
const NODE = "https://lattice-testnet-apps-iad.fly.dev";
const CHAIN = new URL(pageURL).searchParams.get("chain") ?? "Nexus/testnet/wheatpaste-acbbcf";

const me = sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const keyHex = Buffer.from(me.privateKey).toString("hex");
const balance = async () => {
  const url = new URL(`/api/state/account/${me.address}`, NODE);
  url.searchParams.set("chainPath", CHAIN);
  return BigInt((await (await fetch(url, { cache: "no-store" })).json()).balance ?? 0);
};

// Funds, from the operator key.
const operator = fileURLToPath(new URL("../../scripts/operator.mjs", import.meta.url));
console.log(execFileSync("node", [operator, operatorKey, NODE, CHAIN, "fund", me.address, "2000000"], { encoding: "utf8", env: process.env }).trim());
for (let i = 0; (await balance()) < 2_000_000n; i++) {
  if (i > 120) throw new Error("not funded after 10 minutes");
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
console.log(`funded ${me.address}`);

// The first write on a chain asks to reach the hosts the wallet found for it,
// through Chrome's own permission prompt, which a headless browser can't
// answer: the copy installed here has that permission already, as it would
// once a person allowed it.
const wallet = mkdtempSync(`${tmpdir()}/wheatpaste-wallet-`);
cpSync(process.env.LATTICE_WALLET, wallet, { recursive: true });
const manifest = JSON.parse(readFileSync(`${wallet}/manifest.json`, "utf8"));
manifest.host_permissions = [...manifest.host_permissions, "https://*.fly.dev/*"];
writeFileSync(`${wallet}/manifest.json`, JSON.stringify(manifest));

const browser = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/wheatpaste-live-`), {
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ["--headless=new", `--disable-extensions-except=${wallet}`, `--load-extension=${wallet}`],
});
const [worker] = browser.serviceWorkers().length ? browser.serviceWorkers() : [await browser.waitForEvent("serviceworker")];
const origin = worker.url().split("/").slice(0, 3).join("/");
const approved = [];
const said = [];
browser.on("page", async (opened) => {
  await opened.waitForLoadState().catch(() => {});
  if (!opened.url().includes("/approve/index.html")) return;
  await opened.bringToFront();
  const approve = opened.getByRole("button", { name: /^(Connect|Sign write|Pay .+)$/ });
  const rest = opened.getByRole("button", { name: /^See the rest/ });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !(await approve.isEnabled().catch(() => false))) {
    if (await rest.isVisible().catch(() => false)) await rest.click().catch(() => {});
    await opened.waitForTimeout(250);
  }
  await opened.screenshot({ path: `${process.env.SHOTS ?? tmpdir()}/wallet-${approved.length}.png`, fullPage: true }).catch(() => {});
  if (!(await approve.isEnabled().catch(() => false))) {
    said.push((await opened.locator("body").innerText().catch(() => "?")).replace(/\s+/g, " ").slice(0, 600));
    return;
  }
  const label = (await approve.textContent()).trim();
  await approve.click();
  approved.push(label);
});
const setup = await browser.newPage();
await setup.goto(`${origin}/popup/index.html`);
const created = await setup.evaluate((privHex) => chrome.runtime.sendMessage({ type: "createWallet", password: "wheatpaste-test", privHex }), keyHex);
if (!created?.ok) throw new Error(`wallet setup: ${created?.error}`);
await setup.close();

const page = browser.pages()[0] ?? (await browser.newPage());
page.on("pageerror", (error) => console.error("page error:", error.message));
await page.goto(pageURL);
await page.locator(".board .ad").first().waitFor({ timeout: 60_000 });

// Empty space at the bottom left, 5 × 3.
const box = await page.locator("#board").boundingBox();
const at = (x, y) => [box.x + ((x + 0.5) / 32) * box.width, box.y + ((y + 0.5) / 18) * box.height];
await page.mouse.move(...at(1, 15));
await page.mouse.down();
await page.mouse.move(...at(5, 17), { steps: 5 });
await page.mouse.up();
const image = `${mkdtempSync(`${tmpdir()}/wheatpaste-img-`)}/ad.png`;
const art = await browser.newPage();
await art.setViewportSize({ width: 500, height: 300 });
await art.setContent(`<body style="margin:0;background:#7c3aed;color:#fff;font:900 90px Helvetica;display:grid;place-items:center;height:100vh">HELLO</body>`);
await art.screenshot({ path: image });
await art.close();
await page.locator("#file").setInputFiles(image);
await page.fill("#link", "https://example.com/hello");
const button = page.locator("[data-post]");
await button.filter({ hasText: /^Post for / }).waitFor();
const shown = (await button.textContent()).replace("Post for ", "");
await page.screenshot({ path: `${process.env.SHOTS ?? tmpdir()}/page-before.png` });
await button.click();
await page.locator("#toast", { hasText: "Your ad is up." }).waitFor({ timeout: 15 * 60_000 }).catch(async (error) => {
  throw new Error(`no ad: page said "${await page.locator("#toast").textContent()}"; wallet approved [${approved}], said: ${said.join(" || ")}`, { cause: error });
});
await page.screenshot({ path: `${process.env.SHOTS ?? tmpdir()}/page-after.png` });
console.log(`posted: page showed "Post for ${shown}", wallet approved [${approved.join(", ")}]`);
const digits = (text) => text.replace(/[^0-9]/g, "");
assert.ok(approved.some((label) => label.startsWith("Pay") && digits(label) === digits(shown)), `the wallet asked for the total the page showed (${shown})`);
console.log(`balance now ${await balance()}`);
await browser.close();
console.log("PASS");
