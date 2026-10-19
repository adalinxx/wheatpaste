// The board as records, and the writes that change it. Pure: state comes in
// as `[key, value]` entries, writes go out as `{ actions, payments }` for
// the wallet (see the policy for the rules each write meets).

export const WIDTH = 32;
export const HEIGHT = 18;
export const BOARD = { x: 0, y: 0, w: WIDTH, h: HEIGHT };

export const area = (r) => r.w * r.h;
export const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
export const rectText = (r) => `${r.x},${r.y},${r.w},${r.h}`;
export const cellKey = (x, y) => `cell/${x},${y}`;
export const parcelKey = (r) => `parcel/${rectText(r)}`;
export const postKey = (poster, id) => `user/${poster}/post/${id}`;

export function* cellsOf(r) {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) yield [x, y];
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ID = /^[a-z0-9-]{1,64}$/;

function parseRect(text) {
  const parts = text.split(",");
  if (parts.length !== 4 || !parts.every((p) => DECIMAL.test(p))) return null;
  const [x, y, w, h] = parts.map(Number);
  return w >= 1 && h >= 1 && x + w <= WIDTH && y + h <= HEIGHT ? { x, y, w, h } : null;
}

/** A cell's value: `<poster> <id> <rate> <start> <end> <rect>`. */
export function parsePost(value) {
  const f = value.split(" ");
  if (f.length !== 6 || !ID.test(f[1]) || !f.slice(2, 5).every((n) => DECIMAL.test(n))) return null;
  const rect = parseRect(f[5]);
  const [rate, start, end] = f.slice(2, 5).map(BigInt);
  if (!rect || end <= start) return null;
  return { value, poster: f[0], id: f[1], rate, start, end, rect };
}

export const postValue = ({ poster, id, rate, start, end, rect }) => `${poster} ${id} ${rate} ${start} ${end} ${rectText(rect)}`;

/** A parcel's value: `<owner> <min>`, `<owner> <min> <ask>`, or `-` once cut or joined away. */
export function parseParcel(value) {
  if (value === "-") return { retired: true };
  const f = value.split(" ");
  if (f.length < 2 || f.length > 3 || !f.slice(1).every((n) => DECIMAL.test(n))) return null;
  return { owner: f[0], min: BigInt(f[1]), ask: f[2] === undefined ? null : BigInt(f[2]) };
}

export const parcelValue = ({ owner, min, ask }) => [owner, min, ...(ask == null ? [] : [ask])].join(" ");

/**
 * The board at one state, from its `cell/` and `parcel/` entries: live
 * parcels, every cell's value, and the posts, each with whether it is up at
 * `height` (the tip).
 */
export function readBoard(entries, height) {
  height = BigInt(height);
  const cells = new Map();
  const parcels = [];
  const retired = new Map();
  for (const [key, value] of entries) {
    if (key.startsWith("cell/")) cells.set(key, value);
    else if (key.startsWith("parcel/")) {
      const rect = parseRect(key.slice("parcel/".length));
      const parcel = rect && parseParcel(value);
      if (!parcel) continue;
      if (parcel.retired) retired.set(key, value);
      else parcels.push({ key, value, rect, ...parcel });
    }
  }
  const posts = new Map();
  for (const [key, value] of cells) {
    let post = posts.get(value);
    if (!post) {
      const parsed = parsePost(value);
      if (!parsed) continue;
      post = { ...parsed, up: parsed.end > height, cells: 0 };
      posts.set(value, post);
    }
    post.cells++;
  }
  return { height, cells, parcels, retired, posts: [...posts.values()] };
}

export const parcelAt = (board, x, y) => board.parcels.find((p) => inside(p.rect, x, y));
export const upPosts = (board) => board.posts.filter((p) => p.up && p.cells === area(p.rect));

/** The post up in cell (x, y), if any. */
export function postAt(board, x, y) {
  const post = board.posts.find((p) => p.value === board.cells.get(cellKey(x, y)));
  return post?.up ? post : undefined;
}

/**
 * Everything about posting `rect` at `rate` per cell per block until block
 * `end`: what comes down, the rate it must beat, who is paid what, and the
 * write. `start` is the block the post pays from; the policy needs it at or
 * below the block the post lands in, so use the tip height.
 */
export function quotePost(board, { poster, id, rect, rate, start, end }) {
  rate = BigInt(rate);
  start = BigInt(start);
  end = BigInt(end);
  const down = upPosts(board).filter((p) => hits(p.rect, rect));
  const value = postValue({ poster, id, rate, start, end, rect });
  const owed = new Map();
  const owe = (to, amount) => owed.set(to, (owed.get(to) ?? 0n) + amount);
  let emptyMin = 0n;
  let emptyCells = 0;
  const actions = [];
  const parcels = new Set();
  for (const [x, y] of cellsOf(rect)) {
    const parcel = parcelAt(board, x, y);
    if (!parcel) throw new Error(`No parcel holds cell ${x},${y}`);
    parcels.add(parcel);
    owe(parcel.owner, rate * (end - start));
    const old = board.cells.get(cellKey(x, y));
    if (!down.some((p) => inside(p.rect, x, y))) {
      emptyMin += parcel.min;
      emptyCells++;
    }
    actions.push({ key: cellKey(x, y), ...(old === undefined ? {} : { oldValue: old }), newValue: value });
  }
  let cleared = 0;
  for (const p of down) {
    owe(p.poster, p.rate * BigInt(area(p.rect)) * (p.end - start));
    for (const [x, y] of cellsOf(p.rect)) {
      if (inside(rect, x, y)) continue;
      actions.push({ key: cellKey(x, y), oldValue: p.value });
      cleared++;
    }
  }
  for (const p of parcels) actions.push({ key: p.key, oldValue: p.value, newValue: p.value });
  const cells = BigInt(area(rect));
  const replaces = down.reduce((sum, p) => sum + p.rate * BigInt(area(p.rect)), 0n) + emptyMin;
  const minRate = replaces === 0n ? 0n : (replaces + cells - 1n) / cells;
  owed.delete(poster);
  const payments = [...owed].filter(([, amount]) => amount > 0n).map(([to, amount]) => ({ to, amount }));
  return {
    value,
    down,
    emptyCells,
    emptyMin,
    cleared,
    parcels: [...parcels],
    perBlock: rate * cells,
    replaces,
    minRate,
    enough: rate * cells >= replaces,
    cost: payments.reduce((sum, p) => sum + p.amount, 0n),
    payments,
    actions,
  };
}

/** The write that posts `rect`, with the post's content at `user/<poster>/post/<id>`. */
export function post(board, terms, content) {
  const quote = quotePost(board, terms);
  if (!quote.enough) throw new Error(`The rate must be at least ${quote.minRate} per cell per block`);
  const actions = [...quote.actions, { key: postKey(terms.poster, terms.id), newValue: JSON.stringify(content) }];
  return { actions, payments: quote.payments };
}

/** The write a poster sends to take their own post down. No refund. */
export function takeDown(post) {
  return { actions: [...cellsOf(post.rect)].map(([x, y]) => ({ key: cellKey(x, y), oldValue: post.value })), payments: [] };
}

/** The first write on a new board: the whole board, to its first owner. */
export const claimBoard = (owner, min) => ({ actions: [{ key: parcelKey(BOARD), newValue: parcelValue({ owner, min }) }], payments: [] });

/** The owner changes a parcel's minimum, asking price or owner. */
export const setParcel = (parcel, terms) => ({
  actions: [{ key: parcel.key, oldValue: parcel.value, newValue: parcelValue({ owner: parcel.owner, min: parcel.min, ask: parcel.ask, ...terms }) }],
  payments: [],
});

/** Anyone buys a parcel with an asking price: it becomes theirs, not for sale. */
export function buyParcel(parcel, buyer) {
  if (parcel.ask == null) throw new Error("This parcel is not for sale");
  return {
    actions: [{ key: parcel.key, oldValue: parcel.value, newValue: parcelValue({ owner: buyer, min: parcel.min }) }],
    payments: parcel.ask > 0n && parcel.owner !== buyer ? [{ to: parcel.owner, amount: parcel.ask }] : [],
  };
}

/**
 * The owner cuts a parcel in two: across at column `at` (a left part `at`
 * cells wide) or down at row `at`. Both parts keep the owner and minimum.
 */
export function cutParcel(board, parcel, { axis, at }) {
  const r = parcel.rect;
  const [a, b] = axis === "x"
    ? [{ ...r, w: at }, { ...r, x: r.x + at, w: r.w - at }]
    : [{ ...r, h: at }, { ...r, y: r.y + at, h: r.h - at }];
  if (a.w < 1 || a.h < 1 || b.w < 1 || b.h < 1) throw new Error("Cut inside the parcel");
  const part = (rect) => {
    const key = parcelKey(rect);
    const old = board.retired.get(key);
    return { key, ...(old === undefined ? {} : { oldValue: old }), newValue: parcelValue({ owner: parcel.owner, min: parcel.min }) };
  };
  return { actions: [{ key: parcel.key, oldValue: parcel.value, newValue: "-" }, part(a), part(b)], payments: [] };
}
