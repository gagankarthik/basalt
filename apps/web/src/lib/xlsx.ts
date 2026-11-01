/** A real .xlsx from rows, written here so a browser download needs no spreadsheet library. Numbers stay numbers, and text is always stored as text, so a value such as =SUM(A1) can never run as a formula. */
export type XlsxValue = string | number | boolean | null | undefined;

const encoder = new TextEncoder();
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** A zip that stores files without compressing them, which spreadsheet apps read fine. */
function zip(files: [string, string][]) {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const num = (v: DataView, at: number, n: number, size: 2 | 4) => (size === 2 ? v.setUint16(at, n, true) : v.setUint32(at, n, true));
  for (const [name, text] of files) {
    const path = encoder.encode(name), data = encoder.encode(text), crc = crc32(data);
    const head = new Uint8Array(30 + path.length), h = new DataView(head.buffer);
    num(h, 0, 0x04034b50, 4); num(h, 4, 20, 2); num(h, 6, 0x0800, 2); num(h, 14, crc, 4); num(h, 18, data.length, 4); num(h, 22, data.length, 4); num(h, 26, path.length, 2);
    head.set(path, 30);
    const dir = new Uint8Array(46 + path.length), d = new DataView(dir.buffer);
    num(d, 0, 0x02014b50, 4); num(d, 4, 20, 2); num(d, 6, 20, 2); num(d, 8, 0x0800, 2); num(d, 16, crc, 4); num(d, 20, data.length, 4); num(d, 24, data.length, 4); num(d, 28, path.length, 2); num(d, 42, offset, 4);
    dir.set(path, 46);
    parts.push(head, data); central.push(dir);
    offset += head.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  num(e, 0, 0x06054b50, 4); num(e, 8, files.length, 2); num(e, 10, files.length, 2); num(e, 12, size, 4); num(e, 16, offset, 4);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
  return out;
}

// Control characters aren't allowed in XML at all, so they're dropped rather than making the file unreadable
const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const columnName = (i: number) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const MAX_TEXT = 32767;

function cell(v: XlsxValue, ref: string, style: string) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${style}><v>${v}</v></c>`;
  if (typeof v === "boolean") return `<c r="${ref}"${style} t="b"><v>${v ? 1 : 0}</v></c>`;
  const text = typeof v === "object" ? JSON.stringify(v) : String(v);
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(text.slice(0, MAX_TEXT))}</t></is></c>`;
}

/** The first row is the header, shown in bold. */
export function toXlsx(rows: XlsxValue[][], sheet = "Sheet1") {
  const name = esc(sheet.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || "Sheet1");
  const body = rows.map((r, y) => `<row r="${y + 1}">${r.map((v, x) => cell(v, `${columnName(x)}${y + 1}`, y === 0 ? ' s="1"' : "")).join("")}</row>`).join("");
  return zip([
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ["xl/styles.xml", '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`],
  ]);
}

/** A query result as sheet rows. */
export const resultSheet = (r: { columns: { name: string }[]; rows: Record<string, unknown>[] }): XlsxValue[][] => [r.columns.map((c) => c.name), ...r.rows.map((row) => r.columns.map((c) => row[c.name] as XlsxValue))];
