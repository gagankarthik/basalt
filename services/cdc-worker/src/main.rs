//! Reads committed changes from a PostgreSQL replication slot and sends them to Basalt.
//! The slot only moves forward after Basalt accepts a batch, so a crash on either side repeats changes instead of losing them.
use postgres::{Client, NoTls};
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, env, thread, time::{Duration, Instant}};

#[derive(Debug, PartialEq)]
struct Cell { name: String, ty: String, value: Option<String>, unchanged: bool }

/// Reads `name[type]:value` pairs from a test_decoding line.
fn parse_cells(mut s: &str) -> Result<Vec<Cell>, String> {
    let mut out = vec![];
    loop {
        s = s.trim_start();
        if s.is_empty() { return Ok(out); }
        let (name, rest) = if let Some(r) = s.strip_prefix('"') { read_quoted(r, '"')? } else {
            let i = s.find('[').ok_or_else(|| format!("expected a column in: {s}"))?;
            (s[..i].to_string(), &s[i..])
        };
        let rest = rest.strip_prefix('[').ok_or("expected a column type")?;
        let end = rest.find("]:").ok_or("expected the end of a column type")?;
        let ty = rest[..end].to_string();
        let rest = &rest[end + 2..];
        let (cell, rest) = if let Some(r) = rest.strip_prefix('\'') {
            let (v, r) = read_quoted(r, '\'')?;
            (Cell { name, ty, value: Some(v), unchanged: false }, r)
        } else {
            let i = rest.find(' ').unwrap_or(rest.len());
            let raw = &rest[..i];
            let cell = match raw {
                "null" => Cell { name, ty, value: None, unchanged: false },
                "unchanged-toast-datum" => Cell { name, ty, value: None, unchanged: true },
                _ => Cell { name, ty, value: Some(raw.to_string()), unchanged: false },
            };
            (cell, &rest[i..])
        };
        out.push(cell);
        s = rest;
    }
}

/// `s` starts after the opening quote; a doubled quote is a literal one.
fn read_quoted(s: &str, q: char) -> Result<(String, &str), String> {
    let mut out = String::new();
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if c != q { out.push(c); continue; }
        if matches!(it.peek(), Some((_, n)) if *n == q) { out.push(q); it.next(); continue; }
        return Ok((out, &s[i + c.len_utf8()..]));
    }
    Err("a quoted value never ended".into())
}

/// A doubled quote inside a quoted name is a literal one.
fn unquote_table(t: &str) -> String { t.replace("\"\"", "\0").replace('"', "").replace('\0', "\"") }

/// Finds `pat` outside quoted names, so a table called `"a: b"` or `"a, b"` isn't cut in two.
fn find_unquoted(s: &str, pat: &str) -> Option<usize> {
    let mut quoted = false;
    for (i, c) in s.char_indices() {
        if c == '"' { quoted = !quoted; } else if !quoted && s[i..].starts_with(pat) { return Some(i); }
    }
    None
}

/// Without an explicit sslmode the driver falls back to plain text if the server refuses TLS, which someone on the network can force.
fn require_tls(url: &str) -> String {
    if url.contains("sslmode=") { return url.to_string(); }
    if !url.contains("://") { return format!("{url} sslmode=require"); }
    format!("{url}{}sslmode=require", if url.contains('?') { '&' } else { '?' })
}

fn change(table: &str, op: &str, cells: Vec<Cell>) -> Value {
    let mut row = Map::new();
    let mut unchanged = vec![];
    let mut types = Map::new();
    for c in cells {
        types.insert(c.name.clone(), Value::String(c.ty));
        if c.unchanged { unchanged.push(Value::String(c.name)); continue; }
        row.insert(c.name, c.value.map_or(Value::Null, Value::String));
    }
    json!({ "table": table, "op": op, "row": row, "unchanged": unchanged, "types": types })
}

/// Turns one line of test_decoding output into changes. BEGIN and COMMIT give none.
fn parse_line(line: &str) -> Result<Vec<Value>, String> {
    let Some(rest) = line.strip_prefix("table ") else { return Ok(vec![]) };
    let i = find_unquoted(rest, ": ").ok_or_else(|| format!("unreadable change: {line}"))?;
    let (tables, rest) = (&rest[..i], &rest[i + 2..]);
    let j = rest.find(':').ok_or_else(|| format!("unreadable change: {line}"))?;
    let (kind, body) = (&rest[..j], rest[j + 1..].trim_start());
    if kind == "TRUNCATE" {
        let mut out = vec![];
        let mut left = tables;
        while let Some(k) = find_unquoted(left, ", ") {
            out.push(json!({ "table": unquote_table(&left[..k]), "op": "truncate" }));
            left = &left[k + 2..];
        }
        out.push(json!({ "table": unquote_table(left), "op": "truncate" }));
        return Ok(out);
    }
    let table = unquote_table(tables);
    // A table without a replica identity can't say which row changed
    if body.starts_with("(no-tuple-data)") { return Err(format!("{table} has no primary key or replica identity, so its {kind} can't be applied")); }
    match kind {
        "INSERT" => Ok(vec![change(&table, "upsert", parse_cells(body)?)]),
        "DELETE" => Ok(vec![change(&table, "delete", parse_cells(body)?)]),
        "UPDATE" => {
            if let Some(b) = body.strip_prefix("old-key:") {
                let k = b.find(" new-tuple:").ok_or("an update had no new row")?;
                return Ok(vec![change(&table, "delete", parse_cells(&b[..k])?), change(&table, "upsert", parse_cells(&b[k + 11..])?)]);
            }
            Ok(vec![change(&table, "upsert", parse_cells(body)?)])
        }
        _ => Err(format!("unknown change type {kind}")),
    }
}

fn need(name: &str) -> String { env::var(name).unwrap_or_else(|_| { eprintln!("Set {name}."); std::process::exit(2) }) }

fn connect(url: &str) -> Result<Client, String> {
    if url.contains("sslmode=disable") { return Client::connect(url, NoTls).map_err(|e| e.to_string()); }
    let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    Client::connect(&require_tls(url), postgres_native_tls::MakeTlsConnector::new(tls)).map_err(|e| e.to_string())
}

struct Worker { url: String, pipeline: String, token: String, slot: String, batch: i32 }

impl Worker {
    fn post(&self, lsn: &str, changes: &[Value], types: &BTreeMap<String, Value>) -> Result<(), String> {
        let body = json!({ "pipeline": self.pipeline, "lsn": lsn, "changes": changes, "types": types });
        match ureq::post(&format!("{}/api/cdc", self.url)).set("authorization", &format!("Bearer {}", self.token)).timeout(Duration::from_secs(120)).send_json(body) {
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(401, _)) => { eprintln!("Basalt refused this token. Turn real-time sync on again to get a new one."); std::process::exit(3) }
            Err(e) => Err(format!("Basalt: {e}")),
        }
    }

    fn run(&self, source: &str, poll: Duration) -> Result<(), String> {
        let mut db = connect(source)?;
        let err = |e: postgres::Error| e.to_string();
        // Zoned timestamps are written out in the session's zone; full syncs store them as UTC
        db.batch_execute("SET TIME ZONE 'UTC'").map_err(err)?;
        if db.query_opt("SELECT 1 FROM pg_replication_slots WHERE slot_name = $1", &[&self.slot]).map_err(err)?.is_none() {
            db.execute("SELECT pg_create_logical_replication_slot($1, 'test_decoding')", &[&self.slot]).map_err(err)?;
            println!("Created replication slot {}. Run a full sync now so the copy starts from here.", self.slot);
        }
        let mut beat = Instant::now() - Duration::from_secs(60);
        let none: BTreeMap<String, Value> = BTreeMap::new();
        loop {
            // Read first: anything committed after this point is still ahead of it, so moving the slot here when nothing is waiting can't skip a change
            let wal: String = if beat.elapsed() >= Duration::from_secs(60) { db.query_one("SELECT pg_current_wal_lsn()::text", &[]).map_err(err)?.get(0) } else { String::new() };
            let rows = db.query("SELECT lsn::text, data FROM pg_logical_slot_peek_changes($1, NULL, $2, 'include-xids', '0')", &[&self.slot, &self.batch]).map_err(err)?;
            let Some(last) = rows.last() else {
                if !wal.is_empty() {
                    self.post("", &[], &none)?;
                    // Without this, an idle slot keeps WAL from other databases and from vacuum on the source's disk forever
                    db.execute("SELECT pg_replication_slot_advance($1, $2::text::pg_lsn)", &[&self.slot, &wal]).map_err(err)?;
                    beat = Instant::now();
                }
                thread::sleep(poll);
                continue;
            };
            let lsn: String = last.get(0);
            let mut changes = vec![];
            let mut types: BTreeMap<String, Value> = BTreeMap::new();
            for r in &rows {
                match parse_line(r.get(1)) {
                    Ok(c) => for mut one in c {
                        // Masks work on typed values, so Basalt needs each source column's type. Once per table per batch is enough
                        if let (Some(t), Some(ty)) = (one["table"].as_str().map(str::to_string), one.as_object_mut().and_then(|o| o.remove("types"))) {
                            // A delete only names the key, so types add up over the batch rather than replacing each other
                            let all: &mut Value = types.entry(t).or_insert_with(|| json!({}));
                            if let (Some(a), Some(b)) = (all.as_object_mut(), ty.as_object()) { for (k, v) in b { a.insert(k.clone(), v.clone()); } }
                        }
                        changes.push(one);
                    },
                    // One unapplyable row must not stall every other table, and Basalt's next full sync corrects it
                    Err(e) => eprintln!("Skipped a change: {e}"),
                }
            }
            for part in changes.chunks(self.batch as usize) { self.post(&lsn, part, &types)?; }
            if changes.is_empty() { self.post(&lsn, &[], &none)?; }
            beat = Instant::now();
            db.execute("SELECT pg_replication_slot_advance($1, $2::text::pg_lsn)", &[&self.slot, &lsn]).map_err(err)?;
            println!("Applied {} changes up to {lsn}", changes.len());
        }
    }
}

fn main() {
    let pipeline = need("BASALT_PIPELINE");
    let slug: String = pipeline.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' }).collect();
    let w = Worker {
        url: need("BASALT_URL").trim_end_matches('/').to_string(),
        token: need("BASALT_TOKEN"),
        slot: env::var("BASALT_SLOT").unwrap_or(format!("basalt_{slug}")),
        batch: 5000,
        pipeline,
    };
    let source = need("SOURCE_URL");
    let poll = Duration::from_millis(env::var("POLL_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(200));
    println!("Streaming changes into {} through slot {}", w.url, w.slot);
    let mut wait = 1;
    loop {
        let started = Instant::now();
        if let Err(e) = w.run(&source, poll) { eprintln!("Stopped: {e}. Retrying in {wait} seconds."); }
        thread::sleep(Duration::from_secs(wait));
        // A run that lasted a while was healthy, so the next failure starts the wait over
        wait = if started.elapsed() > Duration::from_secs(30) { 1 } else { (wait * 2).min(10) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_all_value_shapes() {
        let c = parse_cells(r#"id[integer]:1 "Full Name"[character varying]:'O''Brien, A' at[timestamp with time zone]:'2026-01-01 00:00:00-05' tags[text[]]:'{a,b}' gone[text]:null big[text]:unchanged-toast-datum ok[boolean]:true"#).unwrap();
        assert_eq!(c[0], Cell { name: "id".into(), ty: "integer".into(), value: Some("1".into()), unchanged: false });
        assert_eq!(c[1], Cell { name: "Full Name".into(), ty: "character varying".into(), value: Some("O'Brien, A".into()), unchanged: false });
        assert_eq!(c[3].ty, "text[]");
        assert_eq!(c[2].value.as_deref(), Some("2026-01-01 00:00:00-05"));
        assert_eq!(c[3].value.as_deref(), Some("{a,b}"));
        assert_eq!(c[4].value, None);
        assert!(!c[4].unchanged);
        assert!(c[5].unchanged);
        assert_eq!(c[6].value.as_deref(), Some("true"));
    }

    #[test]
    fn a_value_that_looks_like_syntax_stays_a_value() {
        let c = parse_cells("a[text]:'x y[int]:2 new-tuple: z' b[int]:3").unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].value.as_deref(), Some("x y[int]:2 new-tuple: z"));
    }

    #[test]
    fn table_names_can_hold_separators_and_quotes() {
        let c = parse_line(r#"table public."a: b": INSERT: id[integer]:1"#).unwrap();
        assert_eq!(c[0]["table"], "public.a: b");
        let t = parse_line(r#"table public."x, y", public."say ""hi""": TRUNCATE: (no-flags)"#).unwrap();
        assert_eq!((t[0]["table"].as_str(), t[1]["table"].as_str()), (Some("public.x, y"), Some("public.say \"hi\"")));
    }

    #[test]
    fn tls_is_required_unless_the_url_says_otherwise() {
        assert_eq!(require_tls("postgres://u:p@h/d"), "postgres://u:p@h/d?sslmode=require");
        assert_eq!(require_tls("postgres://u:p@h/d?application_name=x"), "postgres://u:p@h/d?application_name=x&sslmode=require");
        assert_eq!(require_tls("host=h dbname=d"), "host=h dbname=d sslmode=require");
        assert_eq!(require_tls("postgres://h/d?sslmode=verify-full"), "postgres://h/d?sslmode=verify-full");
    }

    #[test]
    fn reads_each_change_type() {
        assert!(parse_line("BEGIN").unwrap().is_empty());
        assert!(parse_line("COMMIT").unwrap().is_empty());
        let i = parse_line("table public.cust: INSERT: id[integer]:1 tier[text]:'gold'").unwrap();
        assert_eq!(i[0]["op"], "upsert");
        assert_eq!(i[0]["table"], "public.cust");
        assert_eq!(i[0]["row"]["tier"], "gold");
        assert_eq!(i[0]["types"]["id"], "integer");
        assert_eq!(parse_line("table public.cust: DELETE: id[integer]:1").unwrap()[0]["op"], "delete");
        let k = parse_line("table public.cust: UPDATE: old-key: id[integer]:1 new-tuple: id[integer]:2 tier[text]:'x'").unwrap();
        assert_eq!((k[0]["op"].as_str(), k[0]["row"]["id"].as_str()), (Some("delete"), Some("1")));
        assert_eq!((k[1]["op"].as_str(), k[1]["row"]["id"].as_str()), (Some("upsert"), Some("2")));
        assert_eq!(parse_line("table public.a, public.b: TRUNCATE: (no-flags)").unwrap().len(), 2);
        let q = parse_line(r#"table public."My Table": INSERT: id[integer]:1"#).unwrap();
        assert_eq!(q[0]["table"], "public.My Table");
        assert!(parse_line("table public.n: DELETE: (no-tuple-data)").is_err());
    }
}
