// Screenshots of the page against the live trial chain, for design review:
// the board, picking space, an ad, the owners layer, a phone, dark mode.
// A stand-in `window.lattice` makes the page show what it shows with a wallet;
// nothing is signed or sent.
//
//   PLAYWRIGHT=<playwright>/index.mjs node e2e/ui/shots.mjs <page URL> <out directory>
import { mkdirSync } from "node:fs";

const { chromium } = await import(process.env.PLAYWRIGHT);
const [url, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

const wallet = () => {
  window.lattice = { connect: async () => "bafyreieseqa34ntmgfer2auhj6ru4tcr3drvfgq3zrglsinanldc4fgbxy", writeRecords: async () => new Promise(() => {}) };
};

async function open(options = {}, withWallet = true) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...options });
  if (withWallet) await context.addInitScript(wallet);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("page error:", error.message));
  page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
  await page.goto(url);
  await page.waitForSelector(".board .ad, .status:not(:empty)", { timeout: 60_000 });
  await page.waitForTimeout(1500);
  return page;
}

async function dragSquares(page, from, to) {
  const box = await page.locator("#board").boundingBox();
  const at = ({ x, y }) => [box.x + ((x + 0.5) / 32) * box.width, box.y + ((y + 0.5) / 18) * box.height];
  await page.mouse.move(...at(from));
  await page.mouse.down();
  await page.mouse.move(...at(to), { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

let page = await open();
await page.screenshot({ path: `${out}/1-board.png` });
await dragSquares(page, { x: 7, y: 4 }, { x: 13, y: 8 });
await page.screenshot({ path: `${out}/2-pick-over.png` });
await page.locator("#panel [data-close]").click();
await dragSquares(page, { x: 1, y: 9 }, { x: 3, y: 10 });
await page.screenshot({ path: `${out}/3-pick-empty.png` });
await page.keyboard.press("Escape");
const ad = page.locator(".board .ad").first();
if (await ad.count()) {
  await ad.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/4-ad.png` });
}
await page.keyboard.press("Escape");
await page.locator("#owners").click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/5-owners.png` });
const parcel = page.locator(".board .parcel").last();
if (await parcel.count()) {
  await parcel.click({ position: { x: 30, y: 40 } });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/6-parcel.png` });
}

page = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile" }, false);
await page.screenshot({ path: `${out}/7-phone.png` });
if (await page.locator(".board .ad").count()) {
  await page.locator(".board .ad").first().tap();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/8-phone-ad.png` });
}

page = await open({ colorScheme: "dark" }, false);
await dragSquares(page, { x: 7, y: 4 }, { x: 13, y: 8 });
await page.screenshot({ path: `${out}/9-dark-no-wallet.png` });
await browser.close();
