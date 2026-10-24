/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * JavaScript side of omni-index (crates/omni-index), the Rust search core behind the command
 * bar, compiled to WebAssembly and shipped next to this file as omni_index.wasm.
 *
 * The module has no imports and the interface is plain numbers and UTF-8 buffers, so it runs
 * the same in the browser, in the UI preview, and under Node for tests. If the WebAssembly
 * can't be loaded, `OmniIndex.load()` returns a much simpler JavaScript index with the same
 * interface, so the command bar keeps working (more slowly, with plainer ranking).
 */

/** Item kinds, as the Rust side numbers them (also bit positions in a `kinds` filter). */
export const KIND = Object.freeze({ tab: 0, bookmark: 1, history: 2, action: 3, space: 4 });
export const ALL_KINDS = 0b11111;
export const MAX_RESULTS = 64;

const encoder = new TextEncoder();

export class OmniIndex {
  /**
   * @param {WebAssembly.Instance} instance
   */
  constructor(instance) {
    this.exports = instance.exports;
    this.native = true;
    this._buf = 0;
    this._cap = 0;
  }

  /** Instantiate from the module's bytes (an ArrayBuffer or typed array). */
  static async fromBytes(bytes) {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new OmniIndex(instance);
  }

  /**
   * The index the browser uses: the WebAssembly one, or the JavaScript fallback if that fails.
   *
   * @param {object} [options]
   * @param {() => Promise<ArrayBuffer>} [options.readBytes] where the module comes from
   */
  static async load({ readBytes } = {}) {
    try {
      const read =
        readBytes ??
        (async () => {
          const response = await fetch(new URL("omni_index.wasm", import.meta.url).href);
          if (!response.ok) {
            throw new Error(`omni_index.wasm: HTTP ${response.status}`);
          }
          return response.arrayBuffer();
        });
      return await OmniIndex.fromBytes(await read());
    } catch (e) {
      console.error("Halcyon command bar: using the JavaScript index", e);
      return new SimpleIndex();
    }
  }

  /** Write a string into the shared buffer; returns [pointer, length]. */
  _write(text) {
    // UTF-8 is at most 3 bytes per UTF-16 unit.
    const needed = text.length * 3 || 1;
    if (needed > this._cap) {
      if (this._buf) {
        this.exports.omni_free(this._buf, this._cap);
      }
      this._cap = Math.max(needed, 1024);
      this._buf = this.exports.omni_alloc(this._cap);
    }
    // Views go stale when memory grows, so make a fresh one each time.
    const view = new Uint8Array(this.exports.memory.buffer, this._buf, this._cap);
    const { written } = encoder.encodeInto(text, view);
    return [this._buf, written];
  }

  /**
   * Add an item; returns its id.
   *
   * @param {number} kind one of KIND
   * @param {string} title
   * @param {string} url  (for actions: keywords)
   * @param {number} boost 0..100, how useful it has been
   * @param {number} ageDays days since last use
   */
  add(kind, title, url, boost = 0, ageDays = 0) {
    // Title and URL share the buffer, so copy the title out of the way first.
    const titleBytes = encoder.encode(title ?? "");
    const [urlPtr, urlLen] = this._write(url ?? "");
    const titlePtr = this.exports.omni_alloc(titleBytes.length || 1);
    new Uint8Array(this.exports.memory.buffer, titlePtr, titleBytes.length).set(titleBytes);
    const id = this.exports.omni_add(kind, titlePtr, titleBytes.length, urlPtr, urlLen, boost, ageDays) >>> 0;
    this.exports.omni_free(titlePtr, titleBytes.length || 1);
    if (id >>> 0 == 0xffffffff) {
      throw new Error(`omni-index: unknown kind ${kind}`);
    }
    return id;
  }

  remove(id) {
    return this.exports.omni_remove(id) == 1;
  }

  touch(id, boost, ageDays) {
    this.exports.omni_touch(id, boost, ageDays);
  }

  /** Re-rank now (after a bulk load, or when idle) so the next keystroke doesn't pay for it. */
  prepare() {
    this.exports.omni_prepare();
  }

  clear() {
    this.exports.omni_clear();
    // omni_clear doesn't free JS-owned buffers; ours stays valid.
  }

  get size() {
    return this.exports.omni_len();
  }

  /**
   * Best matches, best first.
   *
   * @returns {{id: number, score: number}[]}
   */
  query(text, { kinds = ALL_KINDS, limit = 10 } = {}) {
    const [ptr, len] = this._write(text);
    const count = this.exports.omni_query(ptr, len, kinds, limit);
    if (!count) {
      return [];
    }
    const ids = new Uint32Array(this.exports.memory.buffer, this.exports.omni_results_ptr(), count);
    const scores = new Float32Array(this.exports.memory.buffer, this.exports.omni_scores_ptr(), count);
    const hits = [];
    for (let i = 0; i < count; i++) {
      hits.push({ id: ids[i], score: scores[i] });
    }
    return hits;
  }
}

/**
 * Fallback with the same interface: every word must appear in the title or URL; ranked by
 * where it appears and by usefulness. Linear, so fine for thousands of items, not 100k.
 */
export class SimpleIndex {
  constructor() {
    this.native = false;
    this.clear();
  }

  clear() {
    this.items = [];
    this.live = 0;
  }

  add(kind, title, url, boost = 0, ageDays = 0) {
    if (!Number.isInteger(kind) || kind < 0 || kind > 4) {
      throw new Error(`omni-index: unknown kind ${kind}`);
    }
    const strippedUrl = String(url ?? "")
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/^www\./, "");
    this.items.push({ kind, title: String(title ?? "").toLowerCase(), url: strippedUrl, boost, ageDays, alive: true });
    this.live++;
    return this.items.length - 1;
  }

  remove(id) {
    const item = this.items[id];
    if (!item?.alive) {
      return false;
    }
    item.alive = false;
    this.live--;
    return true;
  }

  touch(id, boost, ageDays) {
    const item = this.items[id];
    if (item?.alive) {
      Object.assign(item, { boost, ageDays });
    }
  }

  prepare() {}

  get size() {
    return this.live;
  }

  static _static(item) {
    const bonus = [40, 18, 0, 30, 30][item.kind];
    return Math.log(1 + item.boost) * 9 + 12 / (1 + item.ageDays / 3) + bonus;
  }

  query(text, { kinds = ALL_KINDS, limit = 10 } = {}) {
    const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
    limit = Math.min(Math.max(limit, 1), MAX_RESULTS);
    const hits = [];
    this.items.forEach((item, id) => {
      if (!item.alive || !(kinds & (1 << item.kind))) {
        return;
      }
      let score = SimpleIndex._static(item);
      if (!words.length) {
        score += item.kind == KIND.tab ? 1000 : 0;
      }
      for (const word of words) {
        const inTitle = item.title.indexOf(word);
        const inUrl = item.url.indexOf(word);
        if (inTitle < 0 && inUrl < 0) {
          return;
        }
        score += inTitle == 0 || inUrl == 0 ? 70 : 40;
      }
      hits.push({ id, score });
    });
    hits.sort((a, b) => b.score - a.score || a.id - b.id);
    return hits.slice(0, limit);
  }
}
