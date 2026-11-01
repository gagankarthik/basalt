import { isUtf8 } from "node:buffer";

export type TextEncoding = "UTF-8" | "UTF-16" | "Windows-1252";

/**
 * A text file as UTF-8, which is all the CSV reader takes. Excel's Unicode text is UTF-16 with a marker, and older systems write Windows-1252.
 * shortcut: anything else that isn't UTF-8 is read as Windows-1252, so Shift-JIS or GBK would come out wrong; the preview names the encoding so people can spot it, add detection if those files turn up.
 */
export function toUtf8(b: Buffer): { bytes: Buffer; encoding: TextEncoding } {
  if (b[0] === 0xff && b[1] === 0xfe) return { bytes: Buffer.from(new TextDecoder("utf-16le").decode(b)), encoding: "UTF-16" };
  if (b[0] === 0xfe && b[1] === 0xff) return { bytes: Buffer.from(new TextDecoder("utf-16be").decode(b)), encoding: "UTF-16" };
  if (isUtf8(b)) return { bytes: b, encoding: "UTF-8" };
  // Text never holds a zero byte, so this is a binary file with the wrong name, and decoding would turn it into nonsense rows
  if (b.includes(0)) throw new Error("This doesn't look like a text file.");
  return { bytes: Buffer.from(new TextDecoder("windows-1252").decode(b)), encoding: "Windows-1252" };
}
