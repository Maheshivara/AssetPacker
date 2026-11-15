(function () {
  "use strict";

  const ATLAS_MAGIC = [0x41, 0x54, 0x4c, 0x53]; // "ATLS"
  const ATLAS_VERSION = 1;
  const HEADER_SIZE = 32;
  const RECORD_SIZE = 32;
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
  const TPAG_STRIDE_SHORT = 22; // GMS 1.4.1804: 11 x u16
  const TPAG_STRIDE_LONG = 26; // older WADs: 13 x u16
  const RECTS_PER_YIELD = 150;
  const MIN_RESOLUTION = 16;
  const MAX_RESOLUTION = 4096;

  /** Read a 4-character ASCII tag. */
  function readTag(bytes, offset) {
    return String.fromCharCode(...bytes.subarray(offset, offset + 4));
  }

  /** Walk the top-level FORM chunks. Returns { TXTR: [offset, length], ... }. */
  function readChunks(view, bytes) {
    if (readTag(bytes, 0) !== "FORM") {
      throw new Error(
        "This is not a GameMaker data file. Choose data.win or game.unx.",
      );
    }
    const end = view.getUint32(4, true) + 8;
    const chunks = {};
    let pos = 8;
    while (pos + 8 <= end) {
      const id = readTag(bytes, pos);
      const length = view.getUint32(pos + 4, true);
      if (!/^[\x20-\x7e]{4}$/.test(id)) break;
      chunks[id] = [pos + 8, length];
      pos = (pos + 8 + length + 3) & ~3; // chunks are 4-byte aligned
    }
    return chunks;
  }

  /** Read a u32 count followed by that many u32 pointers. */
  function readPointerTable(view, offset) {
    const count = view.getUint32(offset, true);
    const pointers = [];
    for (let i = 0; i < count; i++)
      pointers.push(view.getUint32(offset + 4 + i * 4, true));
    return pointers;
  }

  /** TXTR entries are (scaled, blobOffset); a blob ends where the next begins. */
  function parseTexturePages(view, chunkOffset, chunkLength) {
    const pointers = readPointerTable(view, chunkOffset);
    return pointers.map((pointer, i) => {
      const start = view.getUint32(pointer + 4, true);
      const end =
        i + 1 < pointers.length
          ? view.getUint32(pointers[i + 1] + 4, true)
          : chunkOffset + chunkLength;
      return { offset: start, size: Math.max(0, end - start) };
    });
  }

  /** Work out whether TPAG entries are 22 or 26 bytes apart. */
  function detectTpagStride(pointers) {
    if (pointers.length < 2) return TPAG_STRIDE_SHORT;
    const stride = pointers[1] - pointers[0];
    if (stride === TPAG_STRIDE_SHORT || stride === TPAG_STRIDE_LONG)
      return stride;
    const gaps = pointers
      .slice(1)
      .map((p, i) => p - pointers[i])
      .sort((a, b) => a - b);
    return gaps[gaps.length >> 1]; // median gap
  }

  /** Parse every texture page item (TPAG) into a named object. */
  function parseTexturePageItems(view, chunkOffset) {
    const pointers = readPointerTable(view, chunkOffset);
    const stride = detectTpagStride(pointers);
    const pageIdIndex = stride === TPAG_STRIDE_SHORT ? 10 : 12;
    return pointers.map((pointer) => {
      const v = [];
      for (let i = 0; i < stride / 2; i++)
        v.push(view.getUint16(pointer + i * 2, true));
      return {
        sourceX: v[0],
        sourceY: v[1],
        sourceWidth: v[2],
        sourceHeight: v[3],
        targetX: v[4],
        targetY: v[5],
        targetWidth: v[6],
        targetHeight: v[7],
        boundingWidth: v[8],
        boundingHeight: v[9],
        pageId: v[pageIdIndex],
      };
    });
  }

  /** Identity of a source rect: items sharing one are stored only once. */
  function rectKey(item) {
    return [
      item.pageId,
      item.sourceX,
      item.sourceY,
      item.sourceWidth,
      item.sourceHeight,
    ].join(",");
  }

  /** Shrink (w, h) so the long side is at most `cap`. A cap of 0 disables it. */
  function fitToCap(width, height, cap) {
    const longSide = Math.max(width, height);
    if (cap <= 0 || longSide <= cap) return [width, height];
    const scale = cap / longSide;
    return [
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    ];
  }

  /**
   * Crop a rect out of a page and pack it as RGBA4444, two bytes per pixel:
   *   byte 0 = (R & 0xF0) | (B >> 4)
   *   byte 1 = (G & 0xF0) | (A >> 4)
   * When the output is smaller than the source, an alpha-weighted box filter is used.
   */
  function packRect(page, rect, outWidth, outHeight) {
    const { pixels, width: pageWidth } = page;
    const { x: srcX, y: srcY, width: srcW, height: srcH } = rect;
    const out = new Uint8Array(outWidth * outHeight * 2);
    const isScaled = outWidth !== srcW || outHeight !== srcH;
    let o = 0;

    for (let dy = 0; dy < outHeight; dy++) {
      const y0 = isScaled ? Math.floor((dy * srcH) / outHeight) : dy;
      const y1 = isScaled
        ? Math.max(y0 + 1, Math.ceil(((dy + 1) * srcH) / outHeight))
        : dy + 1;

      for (let dx = 0; dx < outWidth; dx++) {
        let r, g, b, a;
        if (!isScaled) {
          const i = ((srcY + dy) * pageWidth + srcX + dx) * 4;
          r = pixels[i];
          g = pixels[i + 1];
          b = pixels[i + 2];
          a = pixels[i + 3];
        } else {
          const x0 = Math.floor((dx * srcW) / outWidth);
          const x1 = Math.max(x0 + 1, Math.ceil(((dx + 1) * srcW) / outWidth));
          let sumR = 0,
            sumG = 0,
            sumB = 0,
            sumA = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const i = ((srcY + y) * pageWidth + srcX + x) * 4;
              const alpha = pixels[i + 3];
              sumR += pixels[i] * alpha;
              sumG += pixels[i + 1] * alpha;
              sumB += pixels[i + 2] * alpha;
              sumA += alpha;
            }
          }
          r = sumA ? sumR / sumA : 0;
          g = sumA ? sumG / sumA : 0;
          b = sumA ? sumB / sumA : 0;
          a = sumA / ((y1 - y0) * (x1 - x0));
        }
        out[o++] = (Math.round(r) & 0xf0) | (Math.round(b) >> 4);
        out[o++] = (Math.round(g) & 0xf0) | (Math.round(a) >> 4);
      }
    }
    return out;
  }

  /** Decode one PNG texture page to raw RGBA using the browser decoder. */
  async function decodePage(bytes, { offset, size }) {
    const raw = bytes.subarray(offset, offset + size);
    if (!PNG_SIGNATURE.every((value, i) => raw[i] === value)) {
      throw new Error(
        "A texture page is not a PNG. This tool supports GameMaker 1.4 files.",
      );
    }
    const bitmap = await createImageBitmap(
      new Blob([raw], { type: "image/png" }),
      { premultiplyAlpha: "none" },
    );
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    bitmap.close();
    canvas.width = canvas.height = 0;
    return { pixels: image.data, width: image.width, height: image.height };
  }

  /**
   * Header (32 bytes): magic, version, tpagCount, pageCount, cap, uniqueCount, padding.
   * Record (32 bytes), little-endian:
   *   u16 srcW, srcH | contentW, contentH | contentX, contentY | storedW, storedH
   *   u32 pixelOffset
   *   u16 boundingW, boundingH | pageId | flags
   *   u32 reserved
   */
  function buildIndex(items, storedRects, pageCount, cap, uniqueCount) {
    const bytes = new Uint8Array(HEADER_SIZE + items.length * RECORD_SIZE);
    const view = new DataView(bytes.buffer);
    bytes.set(ATLAS_MAGIC, 0);
    [ATLAS_VERSION, items.length, pageCount, cap, uniqueCount].forEach(
      (value, i) => view.setUint32(4 + i * 4, value, true),
    );

    let emptyCount = 0;
    items.forEach((item, index) => {
      const stored = storedRects.get(rectKey(item));
      if (!stored) {
        emptyCount++;
        return;
      }
      const at = HEADER_SIZE + index * RECORD_SIZE;
      [
        stored.srcWidth,
        stored.srcHeight,
        Math.max(1, item.targetWidth),
        Math.max(1, item.targetHeight),
        item.targetX,
        item.targetY,
        stored.width,
        stored.height,
      ].forEach((value, i) => view.setUint16(at + i * 2, value, true));
      view.setUint32(at + 16, stored.offset, true);
      [
        Math.max(1, item.boundingWidth),
        Math.max(1, item.boundingHeight),
        item.pageId,
        0,
      ].forEach((value, i) => view.setUint16(at + 20 + i * 2, value, true));
    });
    return { bytes, emptyCount };
  }

  const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * @param {File} file
   * @param {number} cap  longest allowed side of a stored block, in pixels
   * @param {(fraction:number, detail:string, phase?:string) => void} report
   *        `phase` is set only at milestones, so screen readers are not flooded.
   */
  async function packAtlas(file, cap, report) {
    const startedAt = performance.now();
    report(0, "Reading file", "Reading the game file.");
    await nextFrame();

    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const chunks = readChunks(view, bytes);
    if (!chunks.TXTR || !chunks.TPAG)
      throw new Error(
        "The file has no TXTR or TPAG chunk. Is it the right file?",
      );

    const pages = parseTexturePages(view, ...chunks.TXTR);
    const items = parseTexturePageItems(view, chunks.TPAG[0]);

    // Unique source rects, grouped by page so each PNG is decoded once.
    const rectsByPage = new Map();
    const seen = new Set();
    let uniqueCount = 0;
    for (const item of items) {
      if (item.sourceWidth <= 0 || item.sourceHeight <= 0) continue;
      const key = rectKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueCount++;
      if (!rectsByPage.has(item.pageId)) rectsByPage.set(item.pageId, []);
      rectsByPage.get(item.pageId).push({
        key,
        x: item.sourceX,
        y: item.sourceY,
        width: item.sourceWidth,
        height: item.sourceHeight,
      });
    }

    const stored = new Map();
    const blocks = [];
    const stats = { downscaled: 0, clipped: 0, dropped: 0 };
    let byteCount = 0;
    let processed = 0;

    for (const pageId of [...rectsByPage.keys()].sort((a, b) => a - b)) {
      const rects = rectsByPage.get(pageId);
      if (!pages[pageId]) {
        stats.dropped += rects.length;
        processed += rects.length;
        continue;
      }

      report(
        processed / uniqueCount,
        "Decoding page " + (pageId + 1) + " of " + pages.length,
        "Decoding texture page " + (pageId + 1) + " of " + pages.length + ".",
      );
      await nextFrame();
      const page = await decodePage(bytes, pages[pageId]);

      for (let n = 0; n < rects.length; n++) {
        const rect = rects[n];
        processed++;

        // A few rects point past the page edge: clamp them.
        if (rect.x >= page.width || rect.y >= page.height) {
          stats.dropped++;
          continue;
        }
        const clipW = Math.min(rect.width, page.width - rect.x);
        const clipH = Math.min(rect.height, page.height - rect.y);
        if (clipW !== rect.width) stats.clipped++;
        if (clipH !== rect.height) stats.clipped++;

        const [outW, outH] = fitToCap(clipW, clipH, cap);
        if (outW !== clipW || outH !== clipH) stats.downscaled++;

        const block = packRect(
          page,
          { x: rect.x, y: rect.y, width: clipW, height: clipH },
          outW,
          outH,
        );
        stored.set(rect.key, {
          offset: byteCount,
          srcWidth: rect.width,
          srcHeight: rect.height,
          width: outW,
          height: outH,
        });
        blocks.push(block);
        byteCount += block.length;

        if ((n + 1) % RECTS_PER_YIELD === 0) {
          report(
            processed / uniqueCount,
            processed + " of " + uniqueCount + " rects, " + formatMB(byteCount),
          );
          await nextFrame();
        }
      }
    }

    report(0.99, "Writing index", "Writing the index file.");
    await nextFrame();
    const index = buildIndex(items, stored, pages.length, cap, uniqueCount);

    return {
      indexBlob: new Blob([index.bytes]),
      pixelBlob: new Blob(blocks),
      indexSize: index.bytes.length,
      pixelSize: byteCount,
      summary: [
        ["Size cap", cap + " px"],
        ["Texture pages", pages.length],
        ["TPAG items", items.length + " (" + index.emptyCount + " empty)"],
        ["Unique rects", uniqueCount],
        ["Downscaled", stats.downscaled],
        ["Clipped", stats.clipped],
        ["Dropped", stats.dropped],
        ["Elapsed", ((performance.now() - startedAt) / 1000).toFixed(1) + " s"],
      ],
      itemCount: items.length,
    };
  }

  function formatMB(bytes) {
    return (bytes / 1048576).toFixed(2) + " MB";
  }

  const $ = (id) => document.getElementById(id);
  let selectedFile = null;
  let objectUrls = [];

  const ui = {
    drop: $("drop"),
    fileInput: $("file"),
    fileName: $("file-name"),
    fileMeta: $("file-meta"),
    custom: $("custom"),
    customW: $("custom-w"),
    customH: $("custom-h"),
    resNote: $("res-note"),
    resHint: $("res-hint"),
    go: $("go"),
    goHelp: $("go-help"),
    error: $("error"),
    progress: $("progress"),
    track: $("track"),
    fill: $("fill"),
    percent: $("percent"),
    detail: $("detail"),
    phase: $("phase"),
    done: $("done"),
    doneTitle: $("done-title"),
    report: $("report"),
  };

  function chooseFile(file) {
    if (!file) return;
    selectedFile = file;
    ui.drop.classList.add("has-file");
    ui.fileName.textContent = file.name;
    ui.fileMeta.textContent =
      (file.size / 1048576).toFixed(1) +
      " MB selected. Choose another file to replace it.";
    ui.go.disabled = false;
    ui.goHelp.textContent = "Ready to pack.";
  }

  ui.fileInput.addEventListener("change", () =>
    chooseFile(ui.fileInput.files[0]),
  );
  ["dragenter", "dragover"].forEach((name) =>
    ui.drop.addEventListener(name, (event) => {
      event.preventDefault();
      ui.drop.classList.add("is-dragging");
    }),
  );
  ["dragleave", "drop"].forEach((name) =>
    ui.drop.addEventListener(name, (event) => {
      event.preventDefault();
      ui.drop.classList.remove("is-dragging");
    }),
  );
  ui.drop.addEventListener("drop", (event) =>
    chooseFile(event.dataTransfer.files[0]),
  );

  const clampResolution = (value) =>
    Math.min(
      MAX_RESOLUTION,
      Math.max(MIN_RESOLUTION, parseInt(value, 10) || MIN_RESOLUTION),
    );

  function currentTarget() {
    const choice = document.querySelector('input[name="res"]:checked').value;
    if (choice === "custom")
      return {
        width: clampResolution(ui.customW.value),
        height: clampResolution(ui.customH.value),
      };
    const [width, height] = choice.split("x").map(Number);
    return { width, height };
  }

  function updateResolutionHint() {
    const isCustom =
      document.querySelector('input[name="res"]:checked').value === "custom";
    ui.custom.hidden = !isCustom;
    const { width, height } = currentTarget();
    ui.resHint.textContent =
      "Source rects longer than " +
      Math.max(width, height) +
      " px are box-filtered down to that size. Smaller ones keep their full size.";
  }

  /** On blur, snap custom values into range and say so. */
  function clampCustomInputs() {
    const before = [ui.customW.value, ui.customH.value];
    ui.customW.value = clampResolution(ui.customW.value);
    ui.customH.value = clampResolution(ui.customH.value);
    const changed =
      before[0] !== ui.customW.value || before[1] !== ui.customH.value;
    ui.resNote.textContent = changed
      ? "Adjusted to the allowed range of " +
        MIN_RESOLUTION +
        " to " +
        MAX_RESOLUTION +
        " pixels."
      : "";
    updateResolutionHint();
  }

  document
    .querySelectorAll('input[name="res"]')
    .forEach((radio) => radio.addEventListener("change", updateResolutionHint));
  [ui.customW, ui.customH].forEach((input) => {
    input.addEventListener("input", updateResolutionHint);
    input.addEventListener("change", clampCustomInputs);
  });
  updateResolutionHint();

  function showProgress(fraction, detail, phase) {
    const percent = Math.floor(Math.max(0, Math.min(1, fraction)) * 100);
    ui.fill.style.width = percent + "%";
    ui.fill.style.setProperty("--track-width", ui.track.clientWidth + "px");
    ui.track.setAttribute("aria-valuenow", percent);
    ui.track.setAttribute("aria-valuetext", percent + " percent");
    ui.percent.textContent = percent + "%";
    ui.detail.textContent = detail;
    if (phase) ui.phase.textContent = phase;
  }

  function showResult(result) {
    objectUrls.forEach(URL.revokeObjectURL);
    objectUrls = [
      URL.createObjectURL(result.indexBlob),
      URL.createObjectURL(result.pixelBlob),
    ];
    $("dl-bin").href = objectUrls[0];
    $("dl-pix").href = objectUrls[1];
    $("size-bin").textContent =
      formatMB(result.indexSize) + ", " + result.itemCount + " records";
    $("size-pix").textContent = formatMB(result.pixelSize);

    ui.report.replaceChildren();
    for (const [label, value] of result.summary) {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      ui.report.append(dt, dd);
    }
    ui.done.hidden = false;
    ui.doneTitle.focus();
  }

  function showError(message) {
    ui.progress.hidden = true;
    ui.error.textContent = "Packing failed. " + message;
    ui.error.hidden = false;
    ui.error.focus();
  }

  ui.go.addEventListener("click", async () => {
    const { width, height } = currentTarget();
    ui.go.disabled = true;
    ui.goHelp.textContent = "Packing in progress.";
    ui.error.hidden = true;
    ui.done.hidden = true;
    ui.progress.hidden = false;
    ui.progress.focus();
    showProgress(0, "", "Packing started.");

    try {
      const result = await packAtlas(
        selectedFile,
        Math.max(width, height),
        showProgress,
      );
      showProgress(1, "", "Packing finished.");
      showResult(result);
    } catch (error) {
      showError(error.message);
    }
    ui.go.disabled = false;
    ui.goHelp.textContent = "Ready to pack.";
  });
})();
