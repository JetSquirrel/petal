//! `petal-hawdb`: HawDB for Petal, as a program of its own. Petal's desktop builds don't link HawDB (it is
//! most of their size): they download this program the first time HawDB is used and talk to it over its
//! standard input and output. The phone builds link this crate's `Engine` directly instead.
//!
//! The protocol is JSON, one message per line. The program first says who it is:
//!
//! ```text
//! {"ready":true,"protocol":1,"version":"0.1.0"}
//! ```
//!
//! then answers each request with the same `id`, with `result` or `error`:
//!
//! ```text
//! {"id":1,"op":"open","path":"/home/me/petal.hawdb"}   -> {"id":1,"result":null}
//! {"id":2,"op":"query","cypher":"MATCH (n) RETURN n","params":""}  -> {"id":2,"result":{"columns":[…],"rows":[…]}}
//! {"id":3,"op":"execute","cypher":"CREATE (:A)","params":"{}"}     -> {"id":3,"result":{…}}
//! ```
//!
//! One program holds one database. It ends when its input closes, which is also what happens when Petal
//! quits or crashes, so it never keeps a folder locked after Petal is gone.

mod engine;

pub use engine::Engine;

use serde_json::{Value as Json, json};
use std::io::{BufRead, Write};

/// The protocol's version: Petal refuses a helper that speaks another.
pub const PROTOCOL: u64 = 1;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The first line the program writes.
pub fn ready_line() -> String {
    json!({ "ready": true, "protocol": PROTOCOL, "version": VERSION }).to_string()
}

/// Answers the requests read from `input` on `output` until `input` ends.
pub fn serve(input: impl BufRead, mut output: impl Write) -> std::io::Result<()> {
    writeln!(output, "{}", ready_line())?;
    output.flush()?;
    let mut db: Option<Engine> = None;
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let reply = answer(&mut db, &line);
        writeln!(output, "{reply}")?;
        output.flush()?;
    }
    Ok(())
}

fn answer(db: &mut Option<Engine>, line: &str) -> Json {
    let request: Json = match serde_json::from_str(line) {
        Ok(r) => r,
        Err(e) => return json!({ "id": Json::Null, "error": format!("bad request: {e}") }),
    };
    let id = request.get("id").cloned().unwrap_or(Json::Null);
    let field = |k: &str| request.get(k).and_then(Json::as_str).unwrap_or("");
    let result = match field("op") {
        "open" => Engine::open(field("path")).map(|e| {
            *db = Some(e);
            Json::Null
        }),
        "query" => match db.as_mut() {
            Some(e) => e.query_json(field("cypher"), field("params")),
            None => Err("No database is open.".into()),
        },
        "execute" => match db.as_mut() {
            Some(e) => e.execute_json(field("cypher"), field("params")),
            None => Err("No database is open.".into()),
        },
        "close" => {
            *db = None;
            Ok(Json::Null)
        }
        other => Err(format!("unknown op {other:?}")),
    };
    match result {
        Ok(r) => json!({ "id": id, "result": r }),
        Err(e) => json!({ "id": id, "error": e }),
    }
}

#[cfg(test)]
mod tests;
