/** A safe parser and evaluator for Airtable-style formulas. Nothing here uses eval, so a formula can only call the functions below. */
export type FValue = string | number | boolean | Date | null | FValue[];
type Node =
  | { k: "lit"; v: FValue }
  | { k: "field"; name: string }
  | { k: "call"; name: string; args: Node[] }
  | { k: "op"; op: string; l: Node; r: Node }
  | { k: "neg"; v: Node };

export class FormulaError extends Error {}
const fail = (m: string): never => { throw new FormulaError(m); };

function tokenize(src: string) {
  const out: { t: string; v: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) { let j = i + 1; while (j < src.length && /[\d.]/.test(src[j])) j++; out.push({ t: "num", v: src.slice(i, j) }); i = j; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\" && j + 1 < src.length) j++; s += src[j++]; }
      if (j >= src.length) fail("A piece of text is missing its closing quote.");
      out.push({ t: "str", v: s }); i = j + 1; continue;
    }
    if (c === "{") { const j = src.indexOf("}", i); if (j < 0) fail("A field name is missing its closing }."); out.push({ t: "field", v: src.slice(i + 1, j) }); i = j + 1; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < src.length && /\w/.test(src[j])) j++; out.push({ t: "id", v: src.slice(i, j) }); i = j; continue; }
    const two = src.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "!=") { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/&=<>(),%".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    fail(`"${c}" isn't allowed in a formula.`);
  }
  return out;
}

const LEVELS = [["=", "!=", "<", ">", "<=", ">="], ["&"], ["+", "-"], ["*", "/", "%"]];
export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const isOp = (v: string) => toks[p]?.t === "op" && toks[p].v === v;
  const level = (n: number): Node => {
    if (n === LEVELS.length) return unary();
    let l = level(n + 1);
    while (toks[p]?.t === "op" && LEVELS[n].includes(toks[p].v)) { const op = toks[p++].v; l = { k: "op", op, l, r: level(n + 1) }; }
    return l;
  };
  const unary = (): Node => { if (isOp("-")) { p++; return { k: "neg", v: unary() }; } return atom(); };
  const atom = (): Node => {
    const t = toks[p++];
    if (!t) return fail("This formula ends too early.");
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "field") return { k: "field", name: t.v };
    if (t.t === "id") {
      if (!isOp("(")) return { k: "field", name: t.v };
      p++;
      const args: Node[] = [];
      if (!isOp(")")) { do { args.push(level(0)); } while (isOp(",") && ++p); }
      if (!isOp(")")) fail(`${t.v} is missing a closing bracket.`);
      p++;
      return { k: "call", name: t.v.toUpperCase(), args };
    }
    if (t.v === "(") { const e = level(0); if (!isOp(")")) fail("A bracket isn't closed."); p++; return e; }
    return fail(`"${t.v}" is out of place.`);
  };
  const e = level(0);
  if (p < toks.length) fail(`"${toks[p].v}" is out of place.`);
  return e;
}

export const fieldsIn = (n: Node, out: string[] = []): string[] => {
  if (n.k === "field") out.push(n.name);
  else if (n.k === "call") n.args.forEach((a) => fieldsIn(a, out));
  else if (n.k === "op") { fieldsIn(n.l, out); fieldsIn(n.r, out); } else if (n.k === "neg") fieldsIn(n.v, out);
  return out;
};

const flat = (a: FValue[]): FValue[] => a.flatMap((x) => (Array.isArray(x) ? flat(x) : [x]));
const num = (v: FValue): number => {
  if (Array.isArray(v)) return num(flat(v)[0] ?? null);
  if (v == null || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  const n = Number(typeof v === "string" ? v.replace(/[$,%\s]/g, "") : v);
  return Number.isNaN(n) ? fail("A value here isn't a number.") : n;
};
export const text = (v: FValue): string => {
  if (v == null) return "";
  if (Array.isArray(v)) return flat(v).map(text).join(", ");
  if (v instanceof Date) return v.toISOString();
  return typeof v === "boolean" ? (v ? "1" : "0") : String(v);
};
const truthy = (v: FValue): boolean => (Array.isArray(v) ? flat(v).some(truthy) : v instanceof Date ? true : !!v);
const date = (v: FValue): Date => {
  if (v instanceof Date) return v;
  const d = new Date(text(Array.isArray(v) ? flat(v)[0] ?? null : v));
  return Number.isNaN(d.getTime()) ? fail("A value here isn't a date.") : d;
};
const nums = (a: FValue[]) => flat(a).filter((x) => x != null && x !== "").map(num);
const UNIT: Record<string, number> = { milliseconds: 1, ms: 1, seconds: 1000, s: 1000, minutes: 60000, m: 60000, hours: 3600000, h: 3600000, days: 86400000, d: 86400000, weeks: 604800000, w: 604800000 };
const unit = (u: FValue) => { const s = text(u).toLowerCase(); return s === "m" ? "m" : s.endsWith("s") || s.length === 1 ? s : `${s}s`; };
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const addTime = (d: Date, n: number, u: FValue) => {
  const k = unit(u), x = new Date(d);
  if (k === "months" || k === "M") x.setUTCMonth(x.getUTCMonth() + n);
  else if (k === "quarters") x.setUTCMonth(x.getUTCMonth() + n * 3);
  else if (k === "years" || k === "y") x.setUTCFullYear(x.getUTCFullYear() + n);
  else { if (!UNIT[k]) fail(`"${text(u)}" isn't a unit of time.`); x.setTime(x.getTime() + n * UNIT[k]); }
  return x;
};
const dayIndex = (d: Date) => Math.floor(d.getTime() / 86400000);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function format(d: Date, f = "M/D/YYYY") {
  return f.replace(/YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|hh|h|mm|ss|A/g, (t) => ({
    YYYY: String(d.getUTCFullYear()), YY: String(d.getUTCFullYear()).slice(2), MMMM: MONTHS[d.getUTCMonth()], MMM: MONTHS[d.getUTCMonth()].slice(0, 3), MM: pad(d.getUTCMonth() + 1), M: String(d.getUTCMonth() + 1),
    dddd: DAYS[d.getUTCDay()], ddd: DAYS[d.getUTCDay()].slice(0, 3), DD: pad(d.getUTCDate()), D: String(d.getUTCDate()), HH: pad(d.getUTCHours()), hh: pad(d.getUTCHours() % 12 || 12), h: String(d.getUTCHours() % 12 || 12), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds()), A: d.getUTCHours() < 12 ? "AM" : "PM",
  }[t] ?? t));
}
const workdays = (a: Date, b: Date) => { let n = 0; const s = Math.sign(dayIndex(b) - dayIndex(a)) || 1, x = new Date(a); for (;;) { const w = x.getUTCDay(); if (w && w !== 6) n += s; if (dayIndex(x) === dayIndex(b)) return n; x.setUTCDate(x.getUTCDate() + s); } };
const compare = (a: FValue, b: FValue) => { if (a instanceof Date || b instanceof Date) return date(a).getTime() - date(b).getTime(); if (typeof a === "number" || typeof b === "number") return num(a) - num(b); return text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0; };
const regex = (p: FValue, flags = "") => { const s = text(p); if (s.length > 200) fail("That pattern is too long."); try { return new RegExp(s, flags); } catch { return fail("That pattern isn't valid."); } };

type Ctx = { field: (name: string) => FValue; recordId: string; createdAt: string; modifiedAt: string };
type Fn = (a: FValue[]) => FValue;
const FNS: Record<string, Fn> = {
  ARRAYJOIN: ([a, s]) => flat([a]).map(text).join(s == null ? ", " : text(s)), CONCATENATE: (a) => a.map(text).join(""), ENCODE_URL_COMPONENT: ([s]) => encodeURIComponent(text(s)),
  FIND: ([n, h, st]) => text(h).indexOf(text(n), st ? num(st) - 1 : 0) + 1, SEARCH: ([n, h, st]) => { const i = text(h).toLowerCase().indexOf(text(n).toLowerCase(), st ? num(st) - 1 : 0); return i < 0 ? null : i + 1; },
  LEFT: ([s, n]) => text(s).slice(0, num(n)), RIGHT: ([s, n]) => { const t = text(s); return t.slice(Math.max(0, t.length - num(n))); }, MID: ([s, a, n]) => text(s).substr(num(a), num(n)), LEN: ([s]) => text(s).length,
  LOWER: ([s]) => text(s).toLowerCase(), UPPER: ([s]) => text(s).toUpperCase(), TRIM: ([s]) => text(s).trim(), T: ([s]) => (typeof s === "string" ? s : ""),
  REPT: ([s, n]) => text(s).repeat(Math.min(10000, Math.max(0, num(n)))), REPLACE: ([s, st, n, r]) => { const t = text(s), i = num(st) - 1; return t.slice(0, i) + text(r) + t.slice(i + num(n)); },
  SUBSTITUTE: ([s, o, n, idx]) => { const t = text(s), f = text(o); if (!f) return t; if (idx == null) return t.split(f).join(text(n)); let c = 0; return t.split(f).reduce((acc, part) => (++c === num(idx) + 0 ? `${acc}${text(n)}${part}` : `${acc}${f}${part}`)); },
  AND: (a) => (flat(a).every(truthy) ? 1 : 0), OR: (a) => (flat(a).some(truthy) ? 1 : 0), XOR: (a) => (flat(a).filter(truthy).length % 2 ? 1 : 0), NOT: ([v]) => (truthy(v) ? 0 : 1), BLANK: () => null, TRUE: () => 1, FALSE: () => 0, ERROR: ([m]) => fail(m == null ? "ERROR" : text(m)),
  ABS: ([n]) => Math.abs(num(n)), AVERAGE: (a) => { const n = nums(a); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : 0; }, SUM: (a) => nums(a).reduce((x, y) => x + y, 0), MAX: (a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; }, MIN: (a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
  COUNT: (a) => flat(a).filter((x) => typeof x === "number").length, COUNTA: (a) => flat(a).filter((x) => x != null && x !== "").length, COUNTALL: (a) => flat(a).length,
  CEILING: ([n, s]) => { const m = s == null ? 1 : num(s) || 1; return Math.ceil(num(n) / m) * m; }, FLOOR: ([n, s]) => { const m = s == null ? 1 : num(s) || 1; return Math.floor(num(n) / m) * m; }, INT: ([n]) => Math.floor(num(n)), EXP: ([n]) => Math.exp(num(n)), LOG: ([n, b]) => Math.log(num(n)) / Math.log(b == null ? 10 : num(b)),
  EVEN: ([n]) => { const v = num(n), s = v < 0 ? -1 : 1; return s * Math.ceil(Math.abs(v) / 2) * 2; }, ODD: ([n]) => { const v = num(n), s = v < 0 ? -1 : 1, c = Math.ceil(Math.abs(v)); return s * (c % 2 ? c : c + 1); }, MOD: ([a, b]) => num(a) % num(b), POWER: ([a, b]) => num(a) ** num(b), SQRT: ([n]) => (num(n) < 0 ? fail("SQRT needs a number that isn't negative.") : Math.sqrt(num(n)) ),
  ROUND: ([n, p]) => { const f = 10 ** (p == null ? 0 : num(p)); return Math.round(num(n) * f) / f; }, ROUNDDOWN: ([n, p]) => { const f = 10 ** (p == null ? 0 : num(p)); return Math.trunc(num(n) * f) / f; }, ROUNDUP: ([n, p]) => { const f = 10 ** (p == null ? 0 : num(p)), v = num(n) * f; return (v < 0 ? Math.floor(v) : Math.ceil(v)) / f; }, VALUE: ([s]) => num(s),
  DATEADD: ([d, n, u]) => addTime(date(d), num(n), u), DATESTR: ([d]) => date(d).toISOString().slice(0, 10), TIMESTR: ([d]) => date(d).toISOString().slice(11, 19), DATETIME_PARSE: ([s]) => date(s), DATETIME_FORMAT: ([d, f]) => format(date(d), f == null ? undefined : text(f)),
  DATETIME_DIFF: ([a, b, u]) => { const k = unit(u ?? "seconds"), x = date(a), y = date(b); if (k === "months" || k === "M") return (x.getUTCFullYear() - y.getUTCFullYear()) * 12 + x.getUTCMonth() - y.getUTCMonth(); if (k === "years" || k === "y") return x.getUTCFullYear() - y.getUTCFullYear(); if (!UNIT[k]) fail(`"${text(u)}" isn't a unit of time.`); return Math.trunc((x.getTime() - y.getTime()) / UNIT[k]); },
  DAY: ([d]) => date(d).getUTCDate(), HOUR: ([d]) => date(d).getUTCHours(), MINUTE: ([d]) => date(d).getUTCMinutes(), SECOND: ([d]) => date(d).getUTCSeconds(), MONTH: ([d]) => date(d).getUTCMonth() + 1, YEAR: ([d]) => date(d).getUTCFullYear(), WEEKDAY: ([d]) => date(d).getUTCDay(),
  WEEKNUM: ([d]) => { const x = date(d), y = Date.UTC(x.getUTCFullYear(), 0, 1); return Math.floor(((x.getTime() - y) / 86400000 + new Date(y).getUTCDay()) / 7) + 1; },
  IS_AFTER: ([a, b]) => (date(a) > date(b) ? 1 : 0), IS_BEFORE: ([a, b]) => (date(a) < date(b) ? 1 : 0), IS_SAME: ([a, b, u]) => { const x = date(a), y = date(b); if (u == null) return x.getTime() === y.getTime() ? 1 : 0; const k = unit(u); const n = k === "years" ? 4 : k === "months" ? 7 : k === "days" ? 10 : k === "hours" ? 13 : k === "minutes" ? 16 : 19; return x.toISOString().slice(0, n) === y.toISOString().slice(0, n) ? 1 : 0; },
  NOW: () => new Date(), TODAY: () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`), TONOW: ([d]) => Math.abs(dayIndex(new Date()) - dayIndex(date(d))), FROMNOW: ([d]) => Math.abs(dayIndex(date(d)) - dayIndex(new Date())), SET_LOCALE: ([d]) => d, SET_TIMEZONE: ([d, z]) => { const x = date(d); try { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: text(z), hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(x).map((q) => [q.type, Number(q.value)])); return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)); } catch { return fail(`"${text(z)}" isn't a time zone.`); } },
  WORKDAY: ([d, n]) => { let left = Math.abs(num(n)); const s = num(n) < 0 ? -1 : 1, x = new Date(date(d)); while (left > 0) { x.setUTCDate(x.getUTCDate() + s); if (x.getUTCDay() && x.getUTCDay() !== 6) left--; } return x; }, WORKDAY_DIFF: ([a, b]) => workdays(date(a), date(b)),
  ARRAYCOMPACT: ([a]) => flat([a]).filter((x) => x != null && x !== ""), ARRAYFLATTEN: (a) => flat(a), ARRAYUNIQUE: ([a]) => [...new Map(flat([a]).map((x) => [text(x), x])).values()], ARRAYSLICE: ([a, s, e]) => { const l = flat([a]), st = num(s) > 0 ? num(s) - 1 : num(s); return e == null ? l.slice(st) : l.slice(st, num(e) > 0 ? num(e) : num(e)); },
  REGEX_MATCH: ([s, p]) => (regex(p).test(text(s)) ? 1 : 0), REGEX_EXTRACT: ([s, p]) => regex(p).exec(text(s))?.[0] ?? null, REGEX_REPLACE: ([s, p, r]) => text(s).replace(regex(p, "g"), text(r)),
};
export const FORMULA_FUNCTIONS = [...Object.keys(FNS), "IF", "SWITCH", "ISERROR", "CREATED_TIME", "LAST_MODIFIED_TIME", "RECORD_ID"].sort();

export function evalFormula(n: Node, c: Ctx): FValue {
  switch (n.k) {
    case "lit": return n.v;
    case "field": return c.field(n.name);
    case "neg": return -num(evalFormula(n.v, c));
    case "op": {
      const l = evalFormula(n.l, c), r = evalFormula(n.r, c);
      switch (n.op) {
        case "&": return text(l) + text(r);
        case "+": if (l instanceof Date) return new Date(l.getTime() + num(r)); return num(l) + num(r);
        case "-": return num(l) - num(r);
        case "*": return num(l) * num(r);
        case "/": return num(r) === 0 ? fail("A formula tried to divide by zero.") : num(l) / num(r);
        case "%": return num(l) % num(r);
        case "=": return (l == null || l === "" ? "" : l) === (r == null || r === "" ? "" : r) || (l != null && r != null && l !== "" && r !== "" && compare(l, r) === 0) ? 1 : 0;
        case "!=": return evalFormula({ k: "op", op: "=", l: n.l, r: n.r }, c) ? 0 : 1;
        case ">": return compare(l, r) > 0 ? 1 : 0;
        case "<": return compare(l, r) < 0 ? 1 : 0;
        case ">=": return compare(l, r) >= 0 ? 1 : 0;
        default: return compare(l, r) <= 0 ? 1 : 0;
      }
    }
    case "call": {
      const a = n.args;
      // These decide which arguments to work out, so an unused error doesn't matter
      if (n.name === "IF") return truthy(evalFormula(a[0] ?? fail("IF needs a condition."), c)) ? (a[1] ? evalFormula(a[1], c) : null) : (a[2] ? evalFormula(a[2], c) : null);
      if (n.name === "SWITCH") {
        const v = text(evalFormula(a[0] ?? fail("SWITCH needs a value."), c));
        for (let i = 1; i + 1 < a.length; i += 2) if (text(evalFormula(a[i], c)) === v) return evalFormula(a[i + 1], c);
        return a.length % 2 === 0 ? evalFormula(a[a.length - 1], c) : null;
      }
      if (n.name === "ISERROR") { try { evalFormula(a[0], c); return 0; } catch (e) { if (e instanceof FormulaError) return 1; throw e; } }
      if (n.name === "RECORD_ID") return c.recordId;
      if (n.name === "CREATED_TIME") return new Date(c.createdAt);
      if (n.name === "LAST_MODIFIED_TIME") return new Date(c.modifiedAt);
      const fn = FNS[n.name];
      return fn ? fn(a.map((x) => evalFormula(x, c))) : fail(`${n.name} isn't a formula function.`);
    }
  }
}
