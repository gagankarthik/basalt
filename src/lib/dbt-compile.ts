// A small template language for model SQL: ref, source, var, this, is_incremental, config, macros, if, for and set.
// It's an interpreter over parsed data with no eval, no host objects and a work limit, so a template can't run code. Full Jinja is real dbt only.
// Test severity and thresholds are ported from dbt-core (Apache-2.0); see NOTICE.
import { lit, q } from "./sql.ts";
import type { Model, ModelTest, Project } from "./types.ts";

class Safe { s: string; attrs?: Record<string, string>; constructor(s: string, attrs?: Record<string, string>) { this.s = s; this.attrs = attrs; } }
type Expr =
  | { t: "lit"; v: unknown } | { t: "name"; n: string } | { t: "list"; items: Expr[] } | { t: "dict"; items: [string, Expr][] }
  | { t: "attr"; o: Expr; k: Expr } | { t: "call"; f: Expr; args: Expr[]; kw: [string, Expr][] } | { t: "filter"; o: Expr; n: string; args: Expr[] }
  | { t: "un"; op: string; a: Expr } | { t: "bin"; op: string; a: Expr; b: Expr } | { t: "is"; a: Expr; n: string; neg: boolean } | { t: "if"; c: Expr; a: Expr; b?: Expr };
type Node =
  | { t: "text"; s: string } | { t: "out"; e: Expr } | { t: "if"; arms: [Expr | null, Node[]][] }
  | { t: "for"; vars: string[]; e: Expr; body: Node[] } | { t: "set"; n: string; e: Expr };
type MacroDef = { name: string; params: [string, Expr | undefined][]; body: Node[] };

const BLOCKS = new Set(["if", "elif", "else", "endif", "for", "endfor", "set", "macro", "endmacro", "test", "endtest", "raw", "endraw"]);
const MAX_STEPS = 200000, MAX_DEPTH = 40, MAX_OUTPUT = 5_000_000;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/* ---- expressions ---- */
const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_]\w*)|(==|!=|<=|>=|[-+*/%~|.,:()[\]{}<>=]))/y;
type Tok = { k: "num" | "str" | "name" | "op" | "end"; v: string };
function lex(s: string, from: number, close: string): { toks: Tok[]; end: number; rtrim: boolean } | null {
  const toks: Tok[] = []; let i = from;
  for (;;) {
    while (/\s/.test(s[i] ?? "")) i++;
    if (s.startsWith(close, i)) return { toks: [...toks, { k: "end", v: "" }], end: i + close.length, rtrim: false };
    if (s[i] === "-" && s.startsWith(close, i + 1)) return { toks: [...toks, { k: "end", v: "" }], end: i + 1 + close.length, rtrim: true };
    TOKEN.lastIndex = i; const m = TOKEN.exec(s);
    if (!m) return null;
    if (m[1]) toks.push({ k: "num", v: m[1] });
    else if (m[2]) toks.push({ k: "str", v: m[2].slice(1, -1).replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c)) });
    else if (m[3]) toks.push({ k: "name", v: m[3] });
    else toks.push({ k: "op", v: m[4] });
    i = TOKEN.lastIndex;
  }
}
class P {
  toks: Tok[]; i = 0;
  constructor(toks: Tok[]) { this.toks = toks; }
  get cur() { return this.toks[this.i]; }
  is(v: string) { return this.cur.v === v && (this.cur.k === "op" || this.cur.k === "name"); }
  eat(v: string) { if (this.is(v)) { this.i++; return true; } return false; }
  need(v: string) { if (!this.eat(v)) throw new Error(`Expected ${v} in template, found ${this.cur.v || "the end"}`); }
  done() { if (this.cur.k !== "end") throw new Error(`Unexpected ${this.cur.v} in template`); }
  name() { if (this.cur.k !== "name") throw new Error(`Expected a name in template, found ${this.cur.v || "the end"}`); return this.toks[this.i++].v; }
  expr(): Expr { const a = this.or(); if (this.eat("if")) { const c = this.or(); return { t: "if", c, a, b: this.eat("else") ? this.expr() : undefined }; } return a; }
  or(): Expr { let a = this.and(); while (this.eat("or")) a = { t: "bin", op: "or", a, b: this.and() }; return a; }
  and(): Expr { let a = this.not(); while (this.eat("and")) a = { t: "bin", op: "and", a, b: this.not() }; return a; }
  not(): Expr { return this.eat("not") ? { t: "un", op: "not", a: this.not() } : this.cmp(); }
  cmp(): Expr {
    let a = this.cat();
    for (;;) {
      if (["==", "!=", "<", "<=", ">", ">="].some((o) => this.is(o))) { const op = this.toks[this.i++].v; a = { t: "bin", op, a, b: this.cat() }; }
      else if (this.eat("in")) a = { t: "bin", op: "in", a, b: this.cat() };
      else if (this.is("not") && this.toks[this.i + 1]?.v === "in") { this.i += 2; a = { t: "un", op: "not", a: { t: "bin", op: "in", a, b: this.cat() } }; }
      else if (this.eat("is")) { const neg = this.eat("not"); a = { t: "is", a, n: this.name(), neg }; }
      else return a;
    }
  }
  cat(): Expr { let a = this.add(); while (this.eat("~")) a = { t: "bin", op: "~", a, b: this.add() }; return a; }
  add(): Expr { let a = this.mul(); while (this.is("+") || this.is("-")) { const op = this.toks[this.i++].v; a = { t: "bin", op, a, b: this.mul() }; } return a; }
  mul(): Expr { let a = this.unary(); while (this.is("*") || this.is("/") || this.is("%")) { const op = this.toks[this.i++].v; a = { t: "bin", op, a, b: this.unary() }; } return a; }
  unary(): Expr { return this.eat("-") ? { t: "un", op: "-", a: this.unary() } : this.post(); }
  post(): Expr {
    let e = this.atom();
    for (;;) {
      if (this.eat(".")) e = { t: "attr", o: e, k: { t: "lit", v: this.name() } };
      else if (this.eat("[")) { const k = this.expr(); this.need("]"); e = { t: "attr", o: e, k }; }
      else if (this.eat("(")) { const { args, kw } = this.args(); e = { t: "call", f: e, args, kw }; }
      else if (this.eat("|")) { const n = this.name(); e = { t: "filter", o: e, n, args: this.eat("(") ? this.args().args : [] }; }
      else return e;
    }
  }
  args() {
    const args: Expr[] = [], kw: [string, Expr][] = [];
    while (!this.eat(")")) {
      if (this.cur.k === "name" && this.toks[this.i + 1]?.v === "=") { const n = this.name(); this.need("="); kw.push([n, this.expr()]); } else args.push(this.expr());
      if (!this.is(")")) this.need(",");
    }
    return { args, kw };
  }
  atom(): Expr {
    const t = this.cur;
    if (t.k === "num") { this.i++; return { t: "lit", v: Number(t.v) }; }
    if (t.k === "str") { this.i++; return { t: "lit", v: t.v }; }
    if (this.eat("(")) { const e = this.expr(); this.need(")"); return e; }
    if (this.eat("[")) { const items: Expr[] = []; while (!this.eat("]")) { items.push(this.expr()); if (!this.is("]")) this.need(","); } return { t: "list", items }; }
    if (this.eat("{")) {
      const items: [string, Expr][] = [];
      while (!this.eat("}")) { if (this.cur.k !== "str" && this.cur.k !== "name") throw new Error("Dictionary keys must be text in a template"); const k = this.toks[this.i++].v; this.need(":"); items.push([k, this.expr()]); if (!this.is("}")) this.need(","); }
      return { t: "dict", items };
    }
    const n = this.name();
    if (n === "true" || n === "True") return { t: "lit", v: true };
    if (n === "false" || n === "False") return { t: "lit", v: false };
    if (n === "none" || n === "None") return { t: "lit", v: null };
    return { t: "name", n };
  }
}

/* ---- templates ---- */
type Out = { out: P; ltrim: boolean; rtrim: boolean };
type Tag = { k: string; p: P; ltrim: boolean; rtrim: boolean };
function chunks(src: string): (string | Out | Tag)[] {
  const out: (string | Out | Tag)[] = []; let i = 0, text = "";
  while (i < src.length) {
    const j = src.indexOf("{", i);
    if (j < 0) { text += src.slice(i); break; }
    text += src.slice(i, j); i = j;
    const c2 = src[j + 1];
    if (c2 === "#") { const e = src.indexOf("#}", j); if (e < 0) { text += "{"; i = j + 1; continue; } i = e + 2; continue; }
    if (c2 === "{" || c2 === "%") {
      const ltrim = src[j + 2] === "-", start = j + 2 + (ltrim ? 1 : 0), close = c2 === "{" ? "}}" : "%}";
      if (c2 === "%") {
        const kw = /\s*([a-z]+)/y; kw.lastIndex = start; const k = kw.exec(src)?.[1];
        // Not a template tag: LIKE '{%' in plain SQL has to keep working
        if (!k || !BLOCKS.has(k)) { text += "{"; i = j + 1; continue; }
        if (k === "raw") {
          const e = /\{%-?\s*endraw\s*-?%\}/g; e.lastIndex = start; const m = e.exec(src); if (!m) throw new Error("A {% raw %} block has no {% endraw %}");
          text += src.slice(src.indexOf("%}", start) + 2, m.index); i = m.index + m[0].length; continue;
        }
      }
      const l = lex(src, start, close);
      if (!l) { text += "{"; i = j + 1; continue; }
      if (text) { out.push(text); text = ""; }
      const p = new P(l.toks);
      if (c2 === "{") out.push({ out: p, ltrim, rtrim: l.rtrim }); else { const k = p.name(); out.push({ k, p, ltrim, rtrim: l.rtrim }); }
      i = l.end; continue;
    }
    text += "{"; i = j + 1;
  }
  if (text) out.push(text);
  for (let n = 0; n < out.length; n++) {
    const c = out[n]; if (typeof c === "string") continue;
    if (c.ltrim && typeof out[n - 1] === "string") out[n - 1] = (out[n - 1] as string).trimEnd();
    if (c.rtrim && typeof out[n + 1] === "string") out[n + 1] = (out[n + 1] as string).trimStart();
  }
  return out;
}
function parseTemplate(src: string, macros: Map<string, MacroDef>): Node[] {
  const cs = chunks(src); let i = 0;
  const block = (stop: string[]): { nodes: Node[]; end: string; tag?: Tag } => {
    const nodes: Node[] = [];
    while (i < cs.length) {
      const c = cs[i++];
      if (typeof c === "string") { nodes.push({ t: "text", s: c }); continue; }
      if ("out" in c) { const e = c.out.expr(); c.out.done(); nodes.push({ t: "out", e }); continue; }
      if (stop.includes(c.k)) return { nodes, end: c.k, tag: c };
      if (c.k === "if") {
        const arms: [Expr | null, Node[]][] = []; let cond: Expr | null = c.p.expr();
        for (;;) { const b = block(["elif", "else", "endif"]); arms.push([cond, b.nodes]); if (b.end === "endif") break; cond = b.end === "elif" ? b.tag!.p.expr() : null; }
        nodes.push({ t: "if", arms });
      } else if (c.k === "for") {
        const vars = [c.p.name()]; while (c.p.eat(",")) vars.push(c.p.name()); c.p.need("in");
        const e = c.p.expr(), b = block(["endfor"]); nodes.push({ t: "for", vars, e, body: b.nodes });
      } else if (c.k === "set") { const n = c.p.name(); c.p.need("="); nodes.push({ t: "set", n, e: c.p.expr() }); }
      else if (c.k === "macro" || c.k === "test") {
        let name = c.p.name(); if (c.k === "test") name = `test_${name}`;
        const params: [string, Expr | undefined][] = []; c.p.need("(");
        while (!c.p.eat(")")) { const n = c.p.name(); params.push([n, c.p.eat("=") ? c.p.expr() : undefined]); if (!c.p.is(")")) c.p.need(","); }
        macros.set(name, { name, params, body: block([c.k === "test" ? "endtest" : "endmacro"]).nodes });
      } else throw new Error(`Unexpected {% ${c.k} %} in template`);
    }
    if (stop.length) throw new Error(`A template block is missing {% ${stop[stop.length - 1]} %}`);
    return { nodes, end: "" };
  };
  return block([]).nodes;
}

/* ---- evaluation ---- */
const str = (v: unknown): string => {
  if (v instanceof Safe) return v.s;
  if (v == null) return v === null ? "None" : "";
  if (v === true) return "True"; if (v === false) return "False";
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === "string" ? `'${x}'` : str(x))).join(", ")}]`;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};
const truthy = (v: unknown) => (v instanceof Safe ? !!v.s : Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : !!v);
const plain = (v: unknown) => (v instanceof Safe ? v.s : v);
type Scope = Map<string, unknown>;
type Fn = (args: unknown[], kw: Record<string, unknown>) => unknown;
class Runtime {
  steps = 0; depth = 0;
  fns: Record<string, Fn>; macros: Map<string, MacroDef>; escape: (s: string) => string;
  constructor(fns: Record<string, Fn>, macros: Map<string, MacroDef>, escape: (s: string) => string) { this.fns = fns; this.macros = macros; this.escape = escape; }
  tick() { if (++this.steps > MAX_STEPS) throw new Error("This template does too much work and was stopped."); }
  lookup(n: string, sc: Scope[]): unknown { for (let i = sc.length - 1; i >= 0; i--) if (sc[i].has(n)) return sc[i].get(n); return undefined; }
  callable(f: Expr): Fn {
    if (f.t !== "name") throw new Error("Only named macros and functions can be called in a template");
    if (Object.hasOwn(this.fns, f.n)) return this.fns[f.n];
    const m = this.macros.get(f.n); if (m) return (a, k) => this.macro(m, a, k);
    throw new Error(`${f.n}() isn't available in this template. Full Jinja needs an admin and the dbt engine.`);
  }
  macro(m: MacroDef, args: unknown[], kw: Record<string, unknown>) {
    if (++this.depth > MAX_DEPTH) throw new Error(`Macro ${m.name} calls itself too many times.`);
    if (args.length > m.params.length) throw new Error(`Macro ${m.name} takes ${m.params.length} arguments, got ${args.length}`);
    const sc = new Map<string, unknown>();
    m.params.forEach(([n, def], i) => {
      const v = i < args.length ? args[i] : Object.hasOwn(kw, n) ? kw[n] : def ? this.eval(def, [sc]) : undefined;
      if (v === undefined) throw new Error(`Macro ${m.name} needs the argument ${n}`);
      sc.set(n, v);
    });
    const out = this.nodes(m.body, [sc]);
    this.depth--;
    return new Safe(out);
  }
  eval(e: Expr, sc: Scope[]): unknown {
    this.tick();
    switch (e.t) {
      case "lit": return e.v;
      case "name": return this.lookup(e.n, sc) ?? (e.n === "execute" ? true : undefined);
      case "list": return e.items.map((x) => this.eval(x, sc));
      case "dict": { const o = Object.create(null) as Record<string, unknown>; for (const [k, v] of e.items) { if (FORBIDDEN.has(k)) throw new Error(`${k} can't be used in a template`); o[k] = this.eval(v, sc); } return o; }
      case "attr": {
        const o = this.eval(e.o, sc), k = this.eval(e.k, sc);
        if (o instanceof Safe) return typeof k === "string" && o.attrs && Object.hasOwn(o.attrs, k) ? o.attrs[k] : undefined;
        if (typeof k === "string" && FORBIDDEN.has(k)) throw new Error(`${k} can't be used in a template`);
        if (Array.isArray(o) || typeof o === "string") return typeof k === "number" ? o[k < 0 ? o.length + k : k] : undefined;
        return o && typeof o === "object" && typeof k === "string" && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined;
      }
      case "call": {
        const f = this.callable(e.f), kw = Object.create(null) as Record<string, unknown>;
        for (const [k, v] of e.kw) kw[k] = this.eval(v, sc);
        return f(e.args.map((a) => this.eval(a, sc)), kw);
      }
      case "filter": return this.filter(e.n, this.eval(e.o, sc), e.args.map((a) => this.eval(a, sc)));
      case "un": { const a = this.eval(e.a, sc); return e.op === "not" ? !truthy(a) : -Number(plain(a)); }
      case "is": {
        const a = this.eval(e.a, sc), tests: Record<string, boolean> = { defined: a !== undefined, none: a === null, string: typeof a === "string", number: typeof a === "number", iterable: Array.isArray(a) };
        if (!Object.hasOwn(tests, e.n)) throw new Error(`The test "is ${e.n}" isn't available in this template`);
        return e.neg ? !tests[e.n] : tests[e.n];
      }
      case "if": return truthy(this.eval(e.c, sc)) ? this.eval(e.a, sc) : e.b ? this.eval(e.b, sc) : "";
      case "bin": {
        if (e.op === "and") { const a = this.eval(e.a, sc); return truthy(a) ? this.eval(e.b, sc) : a; }
        if (e.op === "or") { const a = this.eval(e.a, sc); return truthy(a) ? a : this.eval(e.b, sc); }
        const a = plain(this.eval(e.a, sc)), b = plain(this.eval(e.b, sc));
        switch (e.op) {
          case "~": return str(a) + str(b);
          case "+": return typeof a === "number" && typeof b === "number" ? a + b : str(a) + str(b);
          case "-": return Number(a) - Number(b);
          case "*": return Number(a) * Number(b);
          case "/": return Number(a) / Number(b);
          case "%": return Number(a) % Number(b);
          case "==": return a === b; case "!=": return a !== b;
          case "<": return (a as number) < (b as number); case "<=": return (a as number) <= (b as number);
          case ">": return (a as number) > (b as number); case ">=": return (a as number) >= (b as number);
          case "in": return Array.isArray(b) ? b.map(plain).includes(a) : typeof b === "string" ? b.includes(String(a)) : !!b && typeof b === "object" && Object.hasOwn(b, String(a));
        }
      }
    }
    throw new Error("Unknown template expression");
  }
  filter(n: string, v: unknown, args: unknown[]) {
    const s = () => str(v);
    switch (n) {
      case "upper": return s().toUpperCase(); case "lower": return s().toLowerCase(); case "trim": return s().trim();
      case "default": case "d": return v === undefined ? args[0] ?? "" : v;
      case "length": case "count": return Array.isArray(v) ? v.length : s().length;
      case "join": if (!Array.isArray(v)) throw new Error("join needs a list"); return v.map(str).join(args.length ? str(args[0]) : "");
      case "replace": return s().split(str(args[0])).join(str(args[1]));
      case "int": return Math.trunc(Number(plain(v))) || 0; case "float": return Number(plain(v)) || 0; case "string": return s();
      case "first": return Array.isArray(v) ? v[0] : undefined; case "last": return Array.isArray(v) ? v[v.length - 1] : undefined;
    }
    throw new Error(`The filter ${n} isn't available in this template`);
  }
  print(v: unknown, label: Expr) {
    if (v === undefined) throw new Error(`${label.t === "name" ? label.n : "This value"} isn't defined in this template`);
    return v instanceof Safe ? v.s : this.escape(str(v));
  }
  nodes(ns: Node[], sc: Scope[]): string {
    let out = "";
    for (const n of ns) {
      this.tick();
      if (n.t === "text") out += this.escape(n.s);
      else if (n.t === "out") out += this.print(this.eval(n.e, sc), n.e);
      else if (n.t === "set") sc[sc.length - 1].set(n.n, this.eval(n.e, sc));
      else if (n.t === "if") { for (const [c, body] of n.arms) if (!c || truthy(this.eval(c, sc))) { out += this.nodes(body, sc); break; } }
      else {
        const list = this.eval(n.e, sc);
        if (!Array.isArray(list)) throw new Error("A for loop needs a list");
        for (let i = 0; i < list.length; i++) {
          const s = new Map<string, unknown>();
          if (n.vars.length === 1) s.set(n.vars[0], list[i]); else n.vars.forEach((v, k) => s.set(v, (list[i] as unknown[])[k]));
          s.set("loop", Object.assign(Object.create(null), { index: i + 1, index0: i, first: i === 0, last: i === list.length - 1, length: list.length }));
          out += this.nodes(n.body, [...sc, s]);
        }
      }
      if (out.length > MAX_OUTPUT) throw new Error("This template produces too much SQL.");
    }
    return out;
  }
}

/* ---- project ---- */
export type Effective = Model & { deps: string[]; srcs: string[]; compileError?: string };
export type Ctx = { models: Model[]; project: Project; byName: Map<string, Model>; macros: Map<string, MacroDef>; effective: Map<string, Effective> };
export type Mode = "warehouse" | "dbt";
const REF = /\{\{\s*ref\(\s*['"](\w+)['"]\s*\)\s*\}\}/g, SRC = /\{\{\s*source\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*\)\s*\}\}/g;
/** Keeps user text from being read as Jinja by real dbt. */
export const dbtEscape = (s: string) => s.replace(/\{[{%#]/g, (m) => `{{ '${m}' }}`);
const usesTemplate = (m: Model) => !m.kind || m.kind === "sql";

export function makeCtx(models: Model[], project: Project = {}): Ctx {
  const macros = new Map<string, MacroDef>();
  if (project.macros?.trim() && parseTemplate(project.macros, macros).some((n) => n.t !== "text" || n.s.trim())) throw new Error("Macros can hold only {% macro %} and {% test %} blocks.");
  return { models, project, byName: new Map(models.map((m) => [m.name, m])), macros, effective: new Map() };
}

type Opts = { mode: Mode; incremental?: boolean; self?: string; stack?: string[]; extra?: Record<string, unknown> };
type Sink = { refs: string[]; srcs: string[]; config: Record<string, unknown> };
function render(text: string, ctx: Ctx, o: Opts, sink?: Sink) {
  const fns: Record<string, Fn> = {
    ref: (a) => { const n = String(a[a.length - 1]); sink?.refs.push(n); return resolveRef(n, ctx, o); },
    source: (a) => {
      if (a.length !== 2) throw new Error("source() takes a connection and a table");
      const [s, t] = [String(a[0]), String(a[1])];
      sink?.srcs.push(`raw_${s}.${t}`);
      return new Safe(o.mode === "dbt" ? `{{ source(${JSON.stringify(s)}, ${JSON.stringify(t)}) }}` : `${q(`raw_${s}`)}.${q(t)}`);
    },
    var: (a) => {
      const n = String(a[0]), vars = ctx.project.vars ?? {};
      if (Object.hasOwn(vars, n)) return vars[n];
      if (a.length > 1) return a[1];
      throw new Error(`The variable ${n} isn't set and has no default`);
    },
    is_incremental: () => !!o.incremental,
    config: (_a, kw) => { if (sink) Object.assign(sink.config, kw); return new Safe(""); },
    range: (a) => { const [from, to] = a.length > 1 ? [Number(a[0]), Number(a[1])] : [0, Number(a[0])]; if (!(to - from <= 10000)) throw new Error("range() is limited to 10,000 values"); return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i); },
  };
  const globals = new Map<string, unknown>(Object.entries(o.extra ?? {}));
  globals.set("target", Object.assign(Object.create(null), { name: "prod", schema: "analytics", type: "duckdb" }));
  if (o.self) globals.set("this", new Safe(o.mode === "dbt" ? "{{ this }}" : `"analytics".${q(o.self)}`, { name: o.self, identifier: o.self, schema: "analytics" }));
  const macros = new Map(ctx.macros), nodes = parseTemplate(text, macros);
  return new Runtime(fns, macros, o.mode === "dbt" ? dbtEscape : (s) => s).nodes(nodes, [globals]);
}
function resolveRef(name: string, ctx: Ctx, o: Opts): Safe {
  if (o.mode === "dbt") return new Safe(`{{ ref(${JSON.stringify(name)}) }}`);
  const m = ctx.byName.get(name);
  if (!m) throw new Error(`This model refers to ${name}, which doesn't exist`);
  if (effectiveOf(m, ctx).materialized === "ephemeral") {
    if (o.stack?.includes(name)) throw new Error(`Models depend on each other: ${[...o.stack, name].join(" > ")}`);
    // A subquery where dbt injects a CTE: same rows, and it can't collide with a WITH in the model that uses it
    return new Safe(`(\n${compileBody(m, ctx, { ...o, self: name, incremental: false, stack: [...(o.stack ?? []), name] })}\n)`);
  }
  return new Safe(`"analytics".${q(name)}`);
}
const stripEnd = (s: string) => s.replace(/;\s*$/, "");
/** Steps and Python only ever contain plain ref and source, and step values are data, so templates don't apply to them. */
function plainBody(sql: string, ctx: Ctx, o: Opts) {
  const parts: string[] = [];
  const held = sql
    .replace(REF, (_, n) => { parts.push(resolveRef(n, ctx, o).s); return `\u0000${parts.length - 1}\u0000`; })
    .replace(SRC, (_, a, b) => { parts.push(o.mode === "dbt" ? `{{ source("${a}", "${b}") }}` : `"raw_${a}"."${b}"`); return `\u0000${parts.length - 1}\u0000`; });
  return (o.mode === "dbt" ? dbtEscape(held) : held).replace(/\u0000(\d+)\u0000/g, (_, i) => parts[Number(i)]);
}
function compileBody(m: Model, ctx: Ctx, o: Opts): string {
  return stripEnd(usesTemplate(m) ? render(m.sql, ctx, { ...o, self: o.self ?? m.name }) : plainBody(m.sql, ctx, o));
}
/** The warehouse SQL for a model, for preview and the build. */
export const compileModel = (m: Model, ctx: Ctx, incremental = false) => compileBody(m, ctx, { mode: "warehouse", incremental, stack: [m.name] });
/** What real dbt gets: templates are already expanded, so the only Jinja left is ref, source, this and is_incremental, which Basalt wrote itself. */
export function compileForDbt(m: Model, ctx: Ctx) {
  if (m.jinja) return m.sql;
  const off = compileBody(m, ctx, { mode: "dbt", incremental: false }), on = compileBody(m, ctx, { mode: "dbt", incremental: true });
  return off === on ? off : `{% if is_incremental() %}${on}{% else %}${off}{% endif %}`;
}
/** Hooks and custom tests go through the same safe templates. */
export const renderSql = (text: string, ctx: Ctx, self: string | undefined, mode: Mode = "warehouse") => stripEnd(render(text, ctx, { mode, self }));

const asList = (v: unknown) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);
/** The model with any {{ config() }} in its SQL applied, plus what it reads, including through macros and branches not taken. */
export function effectiveOf(m: Model, ctx: Ctx): Effective {
  const had = ctx.effective.get(m.name); if (had) return had;
  const sink: Sink = { refs: [], srcs: [], config: {} };
  const e: Effective = { ...m, deps: [], srcs: [] };
  ctx.effective.set(m.name, e);
  if (usesTemplate(m) && !m.jinja) {
    try { render(m.sql, ctx, { mode: "dbt", self: m.name }, sink); } catch (err) { e.compileError = err instanceof Error ? err.message : String(err); }
    const c = sink.config;
    if (c.materialized) { const v = String(c.materialized); if (!["view", "table", "incremental", "snapshot", "ephemeral"].includes(v)) e.compileError = `Unknown materialized value: ${v}`; else e.materialized = v as Model["materialized"]; }
    if (c.unique_key) e.uniqueKey = asList(c.unique_key).join(",");
    if (c.incremental_strategy) { const v = String(c.incremental_strategy); if (!["append", "merge", "delete+insert"].includes(v)) e.compileError = `Unknown incremental_strategy: ${v}`; else e.incrementalStrategy = v as Model["incrementalStrategy"]; }
    if (c.on_schema_change) { const v = String(c.on_schema_change); if (!["ignore", "append_new_columns", "sync_all_columns", "fail"].includes(v)) e.compileError = `Unknown on_schema_change: ${v}`; else e.onSchemaChange = v as Model["onSchemaChange"]; }
    if (c.strategy) { const v = String(c.strategy); if (v !== "timestamp" && v !== "check") e.compileError = `Unknown snapshot strategy: ${v}`; else e.snapshotStrategy = v; }
    if (c.updated_at) e.updatedAt = String(c.updated_at);
    if (c.check_cols) e.checkCols = asList(c.check_cols).join(",");
    if (c.hard_deletes) { const v = String(c.hard_deletes); if (v !== "ignore" && v !== "invalidate") e.compileError = `hard_deletes can be ignore or invalidate here: ${v}`; else e.hardDeletes = v; }
    if (c.tags) e.tags = [...new Set([...(m.tags ?? []), ...asList(c.tags)])];
    if (c.pre_hook) e.preHook = [...(m.preHook ?? []), ...asList(c.pre_hook)];
    if (c.post_hook) e.postHook = [...(m.postHook ?? []), ...asList(c.post_hook)];
  }
  // Branches not taken still count, as they do in dbt's static parse
  e.deps = [...new Set([...sink.refs, ...[...m.sql.matchAll(REF)].map((x) => x[1])])];
  e.srcs = [...new Set([...sink.srcs, ...[...m.sql.matchAll(SRC)].map((x) => `raw_${x[1]}.${x[2]}`)])];
  return e;
}

/* ---- tests ---- */
export const testName = (m: Model, t: ModelTest) => `${t.type}_${m.name}_${t.column}`;
/** Unique within a model, so two custom checks don't overwrite each other's stored failures. */
export const auditName = (m: Model, i: number) => {
  const n = testName(m, m.tests[i]), before = m.tests.slice(0, i).filter((t) => testName(m, t) === n).length;
  return `${n}${before ? `_${before + 1}` : ""}`.replace(/\W/g, "_");
};
/** A query returning the failing rows, the shape dbt tests use. */
export function testSql(m: Model, t: ModelTest, ctx: Ctx, mode: Mode = "warehouse") {
  const rel = (n: string) => (mode === "dbt" ? `{{ ref(${JSON.stringify(n)}) }}` : resolveRef(n, ctx, { mode, stack: [] }).s), text = (s: string) => (mode === "dbt" ? dbtEscape(s) : s);
  const self = rel(m.name), tb = t.where ? `(SELECT * FROM ${self} WHERE ${text(t.where)})` : self, c = q(t.column);
  switch (t.type) {
    case "not_null": return `SELECT * FROM ${tb} x WHERE ${c} IS NULL`;
    case "range": return `SELECT * FROM ${tb} x WHERE ${[t.min != null ? `${c} < ${Number(t.min)}` : "", t.max != null ? `${c} > ${Number(t.max)}` : ""].filter(Boolean).join(" OR ") || "FALSE"}`;
    case "row_count": return `SELECT count(*) AS row_count FROM ${tb} x HAVING count(*) < ${Number(t.min ?? 1)}`;
    case "freshness": return `SELECT max(${c}) AS latest FROM ${tb} x HAVING max(${c}) IS NULL OR max(${c}) < now()::TIMESTAMP - INTERVAL (${Number(t.hours ?? 24)}) HOUR`;
    case "custom": return renderSql(String(t.sql ?? "SELECT 1 WHERE FALSE"), ctx, m.name, mode);
    case "unique": return `SELECT ${c}, count(*) AS n_records FROM ${tb} x WHERE ${c} IS NOT NULL GROUP BY 1 HAVING count(*) > 1`;
    case "accepted_values": return `SELECT * FROM ${tb} x WHERE ${c} IS NOT NULL AND CAST(${c} AS VARCHAR) NOT IN (${(t.values ?? []).map((v) => text(lit(v))).join(", ") || "NULL"})`;
    case "relationships": { const f = q(t.field ?? t.column); return `SELECT x.* FROM ${tb} x LEFT JOIN ${rel(t.to ?? "")} y ON x.${c} = y.${f} WHERE x.${c} IS NOT NULL AND y.${f} IS NULL`; }
    case "generic": {
      const name = `test_${t.macro ?? ""}`;
      if (!ctx.macros.has(name)) throw new Error(`There's no {% test ${t.macro ?? ""} %} macro.`);
      return stripEnd(render(`{{ ${name}(model=__model, column_name=__column) }}`, ctx, { mode, self: m.name, extra: { __model: new Safe(tb), __column: t.column } }));
    }
  }
}
const THRESHOLD = /^\s*(!=|<>|==|=|>=|<=|>|<)\s*(-?\d+)\s*$/, BETWEEN = /^\s*between\s+(-?\d+)\s+and\s+(-?\d+)\s*$/i;
export function meets(n: number, expr: string) {
  const b = BETWEEN.exec(expr); if (b) return n >= Number(b[1]) && n <= Number(b[2]);
  const m = THRESHOLD.exec(expr); if (!m) throw new Error(`Can't read the threshold "${expr}". Use a comparison such as > 10 or between 1 and 5.`);
  const v = Number(m[2]);
  switch (m[1]) { case "!=": case "<>": return n !== v; case "=": case "==": return n === v; case ">": return n > v; case ">=": return n >= v; case "<": return n < v; default: return n <= v; }
}
/** Ported from dbt's test runner: severity error checks error_if then warn_if; severity warn checks warn_if only. */
export function testStatus(failures: number, t: ModelTest): "pass" | "warn" | "fail" {
  if ((t.severity ?? "error") === "error" && meets(failures, t.errorIf || "!=0")) return "fail";
  return meets(failures, t.warnIf || "!=0") ? "warn" : "pass";
}
