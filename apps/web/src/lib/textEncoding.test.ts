import assert from "node:assert/strict";
import test from "node:test";
import { toUtf8 } from "./textEncoding.ts";

test("every common encoding comes out as the same text", () => {
  const text = "id,city\n1,Montréal\n";
  const utf8 = Buffer.from(text);
  assert.equal(toUtf8(utf8).encoding, "UTF-8");
  assert.equal(toUtf8(utf8).bytes, utf8, "UTF-8 isn't copied, since files can be large");
  for (const [b, encoding] of [
    [Buffer.from(text, "latin1"), "Windows-1252"],
    [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]), "UTF-16"],
    [Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]), "UTF-16"],
  ] as const) {
    const r = toUtf8(b);
    assert.equal(r.encoding, encoding);
    assert.equal(r.bytes.toString("utf8").replace(/^\ufeff/, ""), text);
  }
  assert.equal(toUtf8(Buffer.from([0x93, 0x68, 0x69, 0x94])).bytes.toString(), "\u201chi\u201d", "Windows curly quotes");
});
test("a binary file with the wrong name is refused", () => {
  assert.throws(() => toUtf8(Buffer.from([0x89, 0x50, 0, 1, 255])), /text file/);
});
