(() => {
  const report = (event, metrics = {}) =>
    window.__TAURI_INTERNALS__.invoke("benchmark_sample", { sample: { event, ...metrics } });
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const button = (label) =>
    Array.from(document.querySelectorAll("button")).find(
      (candidate) =>
        !candidate.disabled &&
        (candidate.textContent.trim() === label || candidate.getAttribute("aria-label") === label),
    );

  async function until(label, predicate) {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await delay(10);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function benchmark() {
    const editor = await until("the restored SQL editor", () =>
      document.querySelector('.cm-content[contenteditable="true"]'),
    );
    editor.focus();
    await frame();
    await frame();
    await report("editor");

    (await until("Connect", () => button("Connect"))).click();
    await until("one database session", () => button("Disconnect"));
    await report("connected");
    await delay(6_000);

    let firstRowMs;
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (firstRowMs === undefined && /^\d{13}$/.test(text)) {
        firstRowMs = Date.now() - Number(text);
      }
      return original.call(this, text, ...args);
    };
    try {
      (await until("Run", () => button("Run"))).click();
      await until("first painted row", () => firstRowMs !== undefined);
      await report("firstRow", { ms: firstRowMs });
    } finally {
      CanvasRenderingContext2D.prototype.fillText = original;
    }

    (await until("Fetch all", () => button("Fetch all"))).click();
    await until("100,000 rows", () => document.querySelector('[data-row-count="100000"]'));
    const scroll = await until("the grid scroll container", () => document.querySelector(".dvn-scroller"));
    const intervals = [];
    let previous = await frame();
    for (let index = 0; index < 120; index++) {
      scroll.scrollTop = ((scroll.scrollHeight - scroll.clientHeight) * index) / 119;
      const now = await frame();
      intervals.push(now - previous);
      previous = now;
    }
    if (scroll.scrollTop < 1_000_000) throw new Error("The grid did not reach the last rows");
    intervals.sort((a, b) => a - b);
    await report("scroll", { medianMs: intervals[59], p95Ms: intervals[113], maxMs: intervals[119] });
  }

  addEventListener("DOMContentLoaded", () => {
    void benchmark().catch((error) => report("error", { message: String(error) }));
  }, { once: true });
})();
