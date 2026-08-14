(function () {
  "use strict";

  var SOURCE_URL = "/games/senren-banka/content-ebe5177821a6917c7a80/data.xp3";
  var SOURCE_OFFSET = 2311816778;
  var SOURCE_LENGTH = 960793;
  var DESTINATION_LENGTH = 5648096;
  var EXPECTED_ADLER = 665521678;
  var resultElement = document.getElementById("result");
  var results = [];

  function now() { return performance.now(); }

  async function timed(name, action) {
    var started = now();
    try {
      var value = await action();
      results.push({ name: name, ok: true, value: value, elapsedMs: Math.round(now() - started) });
    } catch (error) {
      results.push({ name: name, ok: false, error: error && error.message ? error.message : String(error), elapsedMs: Math.round(now() - started) });
    }
    resultElement.textContent = JSON.stringify(results, null, 2);
  }

  async function withBuffers(module, source, action) {
    var sourcePointer = module._malloc(source.byteLength);
    var destinationPointer = module._malloc(DESTINATION_LENGTH);
    try {
      module.HEAPU8.set(source, sourcePointer);
      return await action(sourcePointer, destinationPointer);
    } finally {
      module._free(destinationPointer);
      module._free(sourcePointer);
    }
  }

  async function run() {
    var response = await fetch(SOURCE_URL, {
      cache: "no-store",
      headers: { Range: "bytes=" + SOURCE_OFFSET + "-" + (SOURCE_OFFSET + SOURCE_LENGTH - 1) }
    });
    if (response.status !== 206) throw new Error("Range HTTP " + response.status);
    var source = new Uint8Array(await response.arrayBuffer());
    if (source.byteLength !== SOURCE_LENGTH) throw new Error("Range length " + source.byteLength);

    var baseline = await window.createD5ZlibBaseline({ noInitialRun: true });
    var asyncify = await window.createD5ZlibAsyncify({ noInitialRun: true });

    await timed("baseline-adler", function () {
      return withBuffers(baseline, source, function (sourcePointer) {
        var value = baseline._d5_zlib_adler(sourcePointer, SOURCE_LENGTH) >>> 0;
        if (value !== EXPECTED_ADLER) throw new Error("Adler " + value);
        return value;
      });
    });
    await timed("baseline-uncompress", function () {
      return withBuffers(baseline, source, function (sourcePointer, destinationPointer) {
        var value = baseline._d5_zlib_uncompress(sourcePointer, SOURCE_LENGTH, destinationPointer, DESTINATION_LENGTH);
        if (value !== 0) throw new Error("zlib " + value);
        return value;
      });
    });
    await timed("asyncify-direct-adler", function () {
      return withBuffers(asyncify, source, function (sourcePointer) {
        var value = asyncify._d5_zlib_adler(sourcePointer, SOURCE_LENGTH) >>> 0;
        if (value !== EXPECTED_ADLER) throw new Error("Adler " + value);
        return value;
      });
    });
    await timed("asyncify-direct-uncompress", function () {
      return withBuffers(asyncify, source, function (sourcePointer, destinationPointer) {
        var value = asyncify._d5_zlib_uncompress(sourcePointer, SOURCE_LENGTH, destinationPointer, DESTINATION_LENGTH);
        if (value !== 0) throw new Error("zlib " + value);
        return value;
      });
    });
    await timed("asyncify-resumed-adler", async function () {
      return await withBuffers(asyncify, source, async function (sourcePointer) {
        var value = await asyncify.ccall("d5_zlib_adler_after_pause", "number", ["number", "number"], [sourcePointer, SOURCE_LENGTH], { async: true });
        value = value >>> 0;
        if (value !== EXPECTED_ADLER) throw new Error("Adler " + value);
        return value;
      });
    });
    await timed("asyncify-resumed-uncompress", async function () {
      return await withBuffers(asyncify, source, async function (sourcePointer, destinationPointer) {
        var value = await asyncify.ccall(
          "d5_zlib_uncompress_after_pause",
          "number",
          ["number", "number", "number", "number"],
          [sourcePointer, SOURCE_LENGTH, destinationPointer, DESTINATION_LENGTH],
          { async: true }
        );
        if (value !== 0) throw new Error("zlib " + value);
        return value;
      });
    });
    window.d5ZlibProbeResults = results;
  }

  window.d5ZlibProbeDone = run().catch(function (error) {
    results.push({ name: "probe", ok: false, error: error && error.stack ? error.stack : String(error) });
    resultElement.textContent = JSON.stringify(results, null, 2);
    window.d5ZlibProbeResults = results;
  });
}());
