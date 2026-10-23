import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

const plugin = process.env.TEST_PLUGIN_DIRECTORY;
assert.ok(plugin, "TEST_PLUGIN_DIRECTORY is required");
const sdk = createRequire(join(plugin, "node_modules/@superblocksteam/sdk/package.json"));
const express = createRequire(sdk.resolve("express"));
const vite = createRequire(
  join(plugin, "node_modules/@superblocksteam/vite-plugin-file-sync/package.json"),
);
const excel = createRequire(vite.resolve("exceljs"));
const ai = createRequire(vite.resolve("ai"));
const gateway = createRequire(ai.resolve("@ai-sdk/gateway"));

test("query parsing enforces the array limit for bracket-key comma input", () => {
  const qs = express("qs");
  assert.throws(
    () =>
      qs.parse("a[]=1,2,3,4", {
        comma: true,
        arrayLimit: 3,
        throwOnLimitExceeded: true,
      }),
    (error) => {
      console.log(JSON.stringify({ operation: "qs.parse", error: error.message }));
      return error instanceof RangeError;
    },
  );
});

test("query parsing and serializing tolerate an attacker-controlled isBuffer value", () => {
  const qs = express("qs");
  const value = qs.parse("a[constructor][isBuffer]=x", { plainObjects: true });
  const serialized = qs.stringify(value);
  assert.equal(serialized, "a%5Bconstructor%5D%5BisBuffer%5D=x");
  console.log(JSON.stringify({ operation: "qs.stringify", serialized }));
});

test("the ExcelJS UUID dependency rejects an undersized output buffer", () => {
  const uuid = excel("uuid");
  assert.throws(
    () => uuid.v5("example", uuid.v5.DNS, new Uint8Array(8), 4),
    (error) => {
      console.log(JSON.stringify({ operation: "uuid.v5", error: error.message }));
      return error instanceof RangeError;
    },
  );
});

for (const [name, consumer] of [
  ["ai", ai],
  ["gateway", gateway],
]) {
  test(`${name} rejects a response declaring an oversized body before reading it`, async () => {
    const utils = consumer("@ai-sdk/provider-utils");
    const handle = utils.createJsonResponseHandler(utils.jsonSchema({ type: "object" }));
    const response = new Response('{"ok":true}', {
      headers: { "content-length": String(2 ** 31 + 1) },
    });
    await assert.rejects(
      handle({ response, url: "https://example.invalid/data", requestBodyValues: {} }),
      (error) => {
        console.log(JSON.stringify({ consumer: name, error: error.message }));
        return /maximum size/.test(error.message);
      },
    );
  });
}

test("ExcelJS writes UUID-backed conditional formatting and reads the workbook", async () => {
  const Excel = vite("exceljs");
  const workbook = new Excel.Workbook();
  const sheet = workbook.addWorksheet("Scores");
  sheet.addRows([[1], [2], [3]]);
  sheet.addConditionalFormatting({
    ref: "A1:A3",
    rules: [
      {
        type: "iconSet",
        iconSet: "3Stars",
        cfvo: [
          { type: "num", value: 0 },
          { type: "num", value: 2 },
          { type: "num", value: 3 },
        ],
      },
    ],
  });
  const bytes = await workbook.xlsx.writeBuffer();
  const zip = await excel("jszip").loadAsync(bytes);
  const xml = await zip.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(
    xml,
    /id="\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}"/i,
  );
  const loaded = new Excel.Workbook();
  await loaded.xlsx.load(bytes);
  assert.deepEqual(loaded.getWorksheet("Scores").getColumn(1).values.slice(1), [1, 2, 3]);
  console.log(
    JSON.stringify({
      workbookBytes: bytes.length,
      conditionalFormattingUuid: xml.match(/id="(\{[0-9A-F-]+\})"/i)?.[1],
      values: loaded.getWorksheet("Scores").getColumn(1).values.slice(1),
    }),
  );
});
