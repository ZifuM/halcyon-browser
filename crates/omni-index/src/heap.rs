/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! A small allocator for the WebAssembly build, which has no operating system and no `std`.
//!
//! * Allocations up to 32 KiB use power-of-two size classes, each with a free list, carved out
//!   of 64 KiB pages. Freed blocks go back on their class's list.
//! * Larger allocations take whole pages. Free runs of pages are kept in a list sorted by
//!   address, merged with their neighbours when freed, and reused first-fit (splitting off what
//!   isn't needed). New pages come from `memory.grow`.
//!
//! The logic is generic over where pages come from, so it's tested natively over a plain
//! buffer (see the tests at the bottom); the WebAssembly build plugs in `memory.grow`.

pub const PAGE: usize = 65536;
const MIN_CLASS: u32 = 4; // 16 bytes
const MAX_SMALL_CLASS: u32 = 15; // 32 KiB
const CLASSES: usize = (MAX_SMALL_CLASS - MIN_CLASS + 1) as usize;
const NONE: usize = 0;

/// Where pages come from: returns the address of `pages` fresh contiguous pages, page aligned.
pub trait PageSource {
    fn grow(&mut self, pages: usize) -> Option<usize>;
}

/// A free run of pages; the header lives in the run's first bytes.
#[repr(C)]
struct Run {
    next: usize,
    pages: usize,
}

pub struct Heap<S: PageSource> {
    source: S,
    /// Heads of the small free lists (0 = empty); a free block's first word links to the next.
    small: [usize; CLASSES],
    /// Unused tail of the page currently being carved, per class.
    carve: [(usize, usize); CLASSES],
    /// Free page runs, sorted by address.
    runs: usize,
}

#[inline]
fn class_of(size: usize, align: usize) -> u32 {
    let need = size.max(align).max(1 << MIN_CLASS);
    usize::BITS - (need - 1).leading_zeros()
}

#[inline]
fn pages_for(size: usize) -> usize {
    size.div_ceil(PAGE)
}

impl<S: PageSource> Heap<S> {
    pub const fn new(source: S) -> Heap<S> {
        Heap { source, small: [NONE; CLASSES], carve: [(0, 0); CLASSES], runs: NONE }
    }

    /// # Safety
    /// Caller must pass the same size and alignment to `free`.
    pub unsafe fn alloc(&mut self, size: usize, align: usize) -> *mut u8 {
        if align > PAGE {
            return core::ptr::null_mut();
        }
        let class = class_of(size, align);
        if class <= MAX_SMALL_CLASS {
            let i = (class - MIN_CLASS) as usize;
            let head = self.small[i];
            if head != NONE {
                self.small[i] = *(head as *const usize);
                return head as *mut u8;
            }
            let block = 1usize << class;
            let (mut at, mut end) = self.carve[i];
            if at == end {
                let Some(page) = self.take_pages(1) else {
                    return core::ptr::null_mut();
                };
                at = page;
                end = page + PAGE;
            }
            self.carve[i] = (at + block, end);
            // Blocks are carved from page-aligned pages in steps of their (power-of-two) size,
            // so every block is aligned to its size, which is at least `align`.
            return at as *mut u8;
        }
        match self.take_pages(pages_for(size)) {
            Some(addr) => addr as *mut u8,
            None => core::ptr::null_mut(),
        }
    }

    /// # Safety
    /// `ptr` must come from `alloc(size, align)` on this heap and not be freed twice.
    pub unsafe fn free(&mut self, ptr: *mut u8, size: usize, align: usize) {
        let class = class_of(size, align);
        if class <= MAX_SMALL_CLASS {
            let i = (class - MIN_CLASS) as usize;
            *(ptr as *mut usize) = self.small[i];
            self.small[i] = ptr as usize;
        } else {
            self.give_pages(ptr as usize, pages_for(size));
        }
    }

    /// First fit from the free runs, else fresh pages.
    unsafe fn take_pages(&mut self, pages: usize) -> Option<usize> {
        let mut prev = NONE;
        let mut cur = self.runs;
        while cur != NONE {
            let run = &mut *(cur as *mut Run);
            if run.pages >= pages {
                let rest = run.pages - pages;
                let next = run.next;
                let replacement = if rest > 0 {
                    // Keep the tail free, in the same place in the list.
                    let tail = cur + pages * PAGE;
                    *(tail as *mut Run) = Run { next, pages: rest };
                    tail
                } else {
                    next
                };
                if prev == NONE {
                    self.runs = replacement;
                } else {
                    (*(prev as *mut Run)).next = replacement;
                }
                return Some(cur);
            }
            prev = cur;
            cur = run.next;
        }
        self.source.grow(pages)
    }

    /// Return pages to the free runs, merging with the runs on either side.
    unsafe fn give_pages(&mut self, addr: usize, pages: usize) {
        let mut prev = NONE;
        let mut cur = self.runs;
        while cur != NONE && cur < addr {
            prev = cur;
            cur = (*(cur as *const Run)).next;
        }
        let mut run = Run { next: cur, pages };
        if cur != NONE && addr + pages * PAGE == cur {
            let after = &*(cur as *const Run);
            run.pages += after.pages;
            run.next = after.next;
        }
        if prev != NONE {
            let before = &mut *(prev as *mut Run);
            if prev + before.pages * PAGE == addr {
                before.pages += run.pages;
                before.next = run.next;
                return;
            }
            before.next = addr;
        } else {
            self.runs = addr;
        }
        *(addr as *mut Run) = run;
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::{Heap, PageSource, PAGE};
    use core::alloc::{GlobalAlloc, Layout};
    use core::cell::UnsafeCell;

    pub struct Memory;

    impl PageSource for Memory {
        fn grow(&mut self, pages: usize) -> Option<usize> {
            let old = core::arch::wasm32::memory_grow(0, pages);
            (old != usize::MAX).then(|| old * PAGE)
        }
    }

    pub struct WasmHeap(UnsafeCell<Heap<Memory>>);

    // WebAssembly here is single-threaded: there is no concurrent access.
    unsafe impl Sync for WasmHeap {}

    unsafe impl GlobalAlloc for WasmHeap {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            (*self.0.get()).alloc(layout.size(), layout.align())
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            (*self.0.get()).free(ptr, layout.size(), layout.align())
        }
    }

    #[global_allocator]
    static HEAP: WasmHeap = WasmHeap(UnsafeCell::new(Heap::new(Memory)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec::Vec;

    /// Pages from a big buffer, like `memory.grow` but bounded.
    struct Buffer {
        base: usize,
        used: usize,
        cap: usize,
        grown: usize,
    }

    impl PageSource for Buffer {
        fn grow(&mut self, pages: usize) -> Option<usize> {
            if self.used + pages > self.cap {
                return None;
            }
            let at = self.base + self.used * PAGE;
            self.used += pages;
            self.grown += 1;
            Some(at)
        }
    }

    fn heap(pages: usize) -> (Heap<Buffer>, Vec<u8>) {
        let backing = vec![0u8; (pages + 1) * PAGE];
        let base = (backing.as_ptr() as usize).next_multiple_of(PAGE);
        (Heap::new(Buffer { base, used: 0, cap: pages, grown: 0 }), backing)
    }

    #[test]
    fn blocks_never_overlap_and_memory_is_reused() {
        let (mut h, _backing) = heap(4096);
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        let mut live: Vec<(usize, usize, usize, u8)> = Vec::new();
        for step in 0..60_000u32 {
            if live.is_empty() || next(100) < 55 {
                let size = match next(10) {
                    0..=5 => 1 + next(200) as usize,
                    6..=8 => 1 + next(40_000) as usize,
                    _ => 1 + next(3 * PAGE as u64 + 7) as usize,
                };
                let align = 1usize << next(5);
                let p = unsafe { h.alloc(size, align) } as usize;
                assert_ne!(p, 0, "out of memory at step {step}");
                assert_eq!(p % align, 0);
                let tag = (step % 251) as u8;
                unsafe { core::ptr::write_bytes(p as *mut u8, tag, size) };
                live.push((p, size, align, tag));
            } else {
                let (p, size, align, tag) = live.swap_remove(next(live.len() as u64) as usize);
                // Nothing else wrote over this block while it was live.
                let bytes = unsafe { core::slice::from_raw_parts(p as *const u8, size) };
                assert!(bytes.iter().all(|&b| b == tag), "block at {p:#x} was overwritten");
                unsafe { h.free(p as *mut u8, size, align) };
            }
        }
        // Reuse kept growth well below what was allocated in total.
        assert!(h.source.used < 2000, "used {} pages", h.source.used);
    }

    #[test]
    fn freed_runs_merge() {
        let (mut h, _backing) = heap(64);
        unsafe {
            let a = h.alloc(2 * PAGE, 8);
            let b = h.alloc(3 * PAGE, 8);
            let c = h.alloc(PAGE + 1, 8);
            h.free(a, 2 * PAGE, 8);
            h.free(c, PAGE + 1, 8);
            h.free(b, 3 * PAGE, 8);
            // All seven pages are one run again: a 7-page allocation fits without growing.
            let grown = h.source.grown;
            let d = h.alloc(7 * PAGE, 8);
            assert_eq!(d, a);
            assert_eq!(h.source.grown, grown);
        }
    }
}
