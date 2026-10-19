//! Transaction-scope validity policy for Wheatpaste, a billboard of 32 × 18
//! cells. The chain is the board.
//!
//! Three shapes of key:
//!
//! - `parcel/<x>,<y>,<w>,<h>`: a rectangle of the board and who owns it,
//!   `<owner> <min>` or `<owner> <min> <ask>`, where `min` is the owner's
//!   rate per cell per block for empty cells and `ask` the price the parcel
//!   sells for. A parcel no longer in use is `-`. Live parcels tile the
//!   board: the first parcel is the whole board, written by its first owner,
//!   and an owner may cut or join their parcels any way that covers the same
//!   cells. The owner may change a parcel in any way; anyone may buy a parcel
//!   with an ask by paying the owner at least the ask. Never deleted.
//! - `cell/<x>,<y>`: what is posted there,
//!   `<poster> <id> <rate> <start> <end> <x>,<y>,<w>,<h>`: one post's terms,
//!   in every cell of its rectangle. A post is up while the block height is
//!   below its end. Anyone may post over anything; a post that touches any
//!   cell of a post still up takes that post down whole, clearing its other
//!   cells. The new post pays each cell's parcel owner its rate for every
//!   block from its start to its end, pays back each post it takes down for
//!   every cell and block that post had left, and pays at least as much per
//!   block as the posts it takes down plus the owners' minimums on the empty
//!   cells it takes. A poster may take down their own post.
//! - `user/<a>/...`: the account's own records (a post's image and link,
//!   labels). `<a>` must sign.
//!
//! Consensus checks every declared old value against the chain, so a post
//! learns who owns its cells by naming each parcel under it, unchanged.
//! Coin actions pass untouched.
#![cfg_attr(not(test), no_std)]

use lattice_policy_rules::{decimal, is_address, transaction_body, Body};

lattice_policy_rules::lattice_policy_abi!(crate::validate);

pub const WIDTH: usize = 32;
pub const HEIGHT: usize = 18;
const CELLS: usize = WIDTH * HEIGHT;
const BOARD: Rect = Rect { x: 0, y: 0, w: WIDTH, h: HEIGHT };
/// A transaction names each parcel once; a re-cut of every cell names at
/// most twice as many parcels as cells.
const MAX_PARCELS: usize = 2 * CELLS;
/// Every parcel owner, every poster taken down, every seller.
const MAX_PAYEES: usize = 2 * CELLS + MAX_PARCELS;

/// The verdict for one policy context. Anything malformed is a rejection.
pub fn validate(context: &[u8]) -> bool {
    check(context).is_some()
}

#[derive(Clone, Copy, PartialEq)]
struct Rect {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
}

impl Rect {
    fn area(&self) -> usize {
        self.w * self.h
    }

    fn contains(&self, cell: usize) -> bool {
        let (x, y) = (cell % WIDTH, cell / WIDTH);
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }

    fn hits(&self, other: &Rect) -> bool {
        self.x < other.x + other.w && other.x < self.x + self.w && self.y < other.y + other.h && other.y < self.y + self.h
    }

    fn corner(&self) -> usize {
        self.y * WIDTH + self.x
    }

    fn cells(self) -> impl Iterator<Item = usize> {
        (self.y..self.y + self.h).flat_map(move |y| (self.x..self.x + self.w).map(move |x| y * WIDTH + x))
    }
}

#[derive(Clone, Copy)]
struct Slot<'a> {
    used: bool,
    old: Option<&'a [u8]>,
    new: Option<&'a [u8]>,
}

impl Slot<'_> {
    const EMPTY: Self = Slot { used: false, old: None, new: None };
}

/// A cell's value: one post's terms.
struct Post<'a> {
    bytes: &'a [u8],
    poster: &'a [u8],
    rate: u64,
    start: u64,
    end: u64,
    rect: Rect,
}

enum Parcel<'a> {
    Live { owner: &'a [u8], min: u64, ask: Option<u64> },
    Retired,
}

/// What each payee is owed in this transaction.
struct Owed<'a> {
    payees: [(&'a [u8], u128); MAX_PAYEES],
    count: usize,
}

impl<'a> Owed<'a> {
    fn add(&mut self, payee: &'a [u8], amount: u128) -> Option<()> {
        if let Some(entry) = self.payees[..self.count].iter_mut().find(|(p, _)| *p == payee) {
            entry.1 = entry.1.checked_add(amount)?;
            return Some(());
        }
        *self.payees.get_mut(self.count)? = (payee, amount);
        self.count += 1;
        Some(())
    }

    /// Every payee who did not sign is credited at least what they are owed.
    fn paid(&self, body: &Body) -> Option<()> {
        for &(payee, amount) in &self.payees[..self.count] {
            if body.is_signer(payee).is_none() && body.credited(payee)? < amount {
                return None;
            }
        }
        Some(())
    }
}

fn check(context: &[u8]) -> Option<()> {
    let body = Body::parse(transaction_body(context)?)?;
    // After the magic, encoding version, ABI version and scope.
    let height = u64::from_be_bytes(context.get(11..19)?.try_into().ok()?);
    let mut cells = [Slot::EMPTY; CELLS];
    let mut parcels = [(BOARD, Slot::EMPTY); MAX_PARCELS];
    let mut parcel_count = 0;
    for action in body.actions()? {
        let action = action?;
        let slot = Slot { used: true, old: action.old_value, new: action.new_value };
        if let Some(point) = action.key.strip_prefix(b"cell/") {
            let cell = parse_point(point)?;
            if cells[cell].used {
                return None;
            }
            cells[cell] = slot;
        } else if let Some(rect) = action.key.strip_prefix(b"parcel/") {
            let rect = parse_rect(rect)?;
            if parcels[..parcel_count].iter().any(|(other, _)| *other == rect) {
                return None;
            }
            *parcels.get_mut(parcel_count)? = (rect, slot);
            parcel_count += 1;
        } else if let Some(rest) = action.key.strip_prefix(b"user/") {
            body.is_signer(rest.split(|&byte| byte == b'/').next()?)?;
        } else {
            return None;
        }
    }
    let parcels = &parcels[..parcel_count];
    let mut owed = Owed { payees: [(&[][..], 0); MAX_PAYEES], count: 0 };
    check_parcels(&body, parcels, &mut owed)?;
    check_cells(&body, height, &cells, parcels, &mut owed)?;
    owed.paid(&body)
}

fn check_parcels<'a>(body: &Body, parcels: &[(Rect, Slot<'a>)], owed: &mut Owed<'a>) -> Option<()> {
    // Cells given up and taken on by cuts and joins; they must match.
    let mut retired = [0u8; CELLS];
    let mut created = [0u8; CELLS];
    let mark = |counts: &mut [u8; CELLS], rect: &Rect| {
        for cell in rect.cells() {
            counts[cell] = counts[cell].saturating_add(1);
        }
    };
    for (rect, slot) in parcels {
        let new = slot.new?;
        let parcel = parse_parcel(new)?;
        match (slot.old, parcel) {
            // Named unchanged, so a post can see who owns it.
            (Some(old), _) if old == new => {}
            (None, Parcel::Live { owner, .. }) if *rect == BOARD => body.is_signer(owner)?,
            (None, Parcel::Live { .. }) => mark(&mut created, rect),
            (None, Parcel::Retired) => return None,
            (Some(old), parcel) => match (parse_parcel(old)?, parcel) {
                (Parcel::Retired, Parcel::Live { .. }) => mark(&mut created, rect),
                (Parcel::Retired, Parcel::Retired) => return None,
                (Parcel::Live { owner, .. }, Parcel::Retired) => {
                    body.is_signer(owner)?;
                    mark(&mut retired, rect);
                }
                (Parcel::Live { owner, ask, .. }, Parcel::Live { .. }) => {
                    if body.is_signer(owner).is_none() {
                        owed.add(owner, ask? as u128)?;
                    }
                }
            },
        }
    }
    (0..CELLS).all(|cell| retired[cell] <= 1 && created[cell] == retired[cell]).then_some(())
}

fn check_cells<'a>(
    body: &Body,
    height: u64,
    cells: &[Slot<'a>; CELLS],
    parcels: &[(Rect, Slot<'a>)],
    owed: &mut Owed<'a>,
) -> Option<()> {
    // At most one new post, written to exactly its rectangle.
    let mut post: Option<Post> = None;
    for slot in cells {
        if let Some(new) = slot.new {
            match &post {
                None => post = Some(parse_post(new)?),
                Some(post) if post.bytes == new => {}
                Some(_) => return None,
            }
        }
    }
    let mut need: u128 = 0;
    if let Some(post) = &post {
        body.is_signer(post.poster)?;
        if post.start > height || height >= post.end {
            return None;
        }
        if (0..CELLS).any(|cell| cells[cell].new.is_some() != post.rect.contains(cell)) {
            return None;
        }
        let per_cell = (post.rate as u128).checked_mul((post.end - post.start) as u128)?;
        for cell in post.rect.cells() {
            let (owner, min) = parcel_under(parcels, cell)?;
            owed.add(owner, per_cell)?;
            let empty = match cells[cell].old {
                None => true,
                Some(old) => parse_post(old)?.end <= height,
            };
            if empty {
                need = need.checked_add(min as u128)?;
            }
        }
    }
    // Every post still up that the transaction touches comes down whole,
    // checked once, at its top-left cell.
    for (cell, slot) in cells.iter().enumerate() {
        let Some(old) = slot.old else { continue };
        let up = parse_post(old)?;
        if !up.rect.contains(cell) {
            return None;
        }
        if up.end <= height {
            // Ended: anyone may clear it or post over it.
            continue;
        }
        if cells[up.rect.corner()].old != Some(up.bytes) {
            return None;
        }
        if cell != up.rect.corner() {
            continue;
        }
        if up.rect.cells().any(|cell| cells[cell].old != Some(up.bytes)) {
            return None;
        }
        match &post {
            Some(post) if post.rect.hits(&up.rect) => {
                let per_block = (up.rate as u128).checked_mul(up.rect.area() as u128)?;
                need = need.checked_add(per_block)?;
                owed.add(up.poster, per_block.checked_mul((up.end - post.start) as u128)?)?;
            }
            _ => body.is_signer(up.poster)?,
        }
    }
    match &post {
        Some(post) if (post.rate as u128).checked_mul(post.rect.area() as u128)? < need => None,
        _ => Some(()),
    }
}

/// The owner and minimum of the live parcel named unchanged that holds `cell`.
fn parcel_under<'a>(parcels: &[(Rect, Slot<'a>)], cell: usize) -> Option<(&'a [u8], u64)> {
    parcels.iter().find_map(|(rect, slot)| match (slot.old, slot.new) {
        (Some(old), Some(new)) if old == new && rect.contains(cell) => match parse_parcel(old)? {
            Parcel::Live { owner, min, .. } => Some((owner, min)),
            Parcel::Retired => None,
        },
        _ => None,
    })
}

fn fields(value: &[u8]) -> impl Iterator<Item = &[u8]> {
    value.split(|&byte| byte == b' ')
}

fn parse_parcel(value: &[u8]) -> Option<Parcel<'_>> {
    if value == b"-" {
        return Some(Parcel::Retired);
    }
    let mut fields = fields(value);
    let owner = fields.next().filter(|owner| is_address(owner))?;
    let min = decimal(fields.next()?)?;
    let ask = match fields.next() {
        None => None,
        Some(ask) => Some(decimal(ask)?),
    };
    fields.next().is_none().then_some(Parcel::Live { owner, min, ask })
}

fn parse_post(value: &[u8]) -> Option<Post<'_>> {
    let mut fields = fields(value);
    let poster = fields.next().filter(|poster| is_address(poster))?;
    let id = fields.next()?;
    if id.is_empty() || id.len() > 64 || !id.iter().all(|&byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-')) {
        return None;
    }
    let rate = decimal(fields.next()?)?;
    let start = decimal(fields.next()?)?;
    let end = decimal(fields.next()?)?;
    let rect = parse_rect(fields.next()?)?;
    if fields.next().is_some() || end <= start {
        return None;
    }
    Some(Post { bytes: value, poster, rate, start, end, rect })
}

fn numbers<const N: usize>(text: &[u8]) -> Option<[usize; N]> {
    let mut parts = text.split(|&byte| byte == b',');
    let mut out = [0; N];
    for slot in &mut out {
        *slot = usize::try_from(decimal(parts.next()?)?).ok()?;
    }
    parts.next().is_none().then_some(out)
}

fn parse_point(text: &[u8]) -> Option<usize> {
    let [x, y] = numbers(text)?;
    (x < WIDTH && y < HEIGHT).then_some(y * WIDTH + x)
}

fn parse_rect(text: &[u8]) -> Option<Rect> {
    let [x, y, w, h] = numbers(text)?;
    (w >= 1 && h >= 1 && x.checked_add(w)? <= WIDTH && y.checked_add(h)? <= HEIGHT).then_some(Rect { x, y, w, h })
}
