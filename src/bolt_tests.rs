//! The Bolt client against a scripted Bolt server: the handshake, HELLO, RUN with PULL or DISCARD, and the
//! records, written byte for byte in PackStream as Memgraph sends them.

use super::imp;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

// --- PackStream, the little of it the script needs ---------------------------------------------------------

fn string(out: &mut Vec<u8>, s: &str) {
    let b = s.as_bytes();
    if b.len() < 16 {
        out.push(0x80 | b.len() as u8);
    } else {
        out.push(0xD0);
        out.push(b.len() as u8);
    }
    out.extend_from_slice(b);
}

fn int(out: &mut Vec<u8>, i: i64) {
    if (-16..128).contains(&i) {
        out.push(i as i8 as u8);
    } else {
        out.push(0xCB);
        out.extend_from_slice(&i.to_be_bytes());
    }
}

fn list(out: &mut Vec<u8>, n: usize) {
    out.push(0x90 | n as u8);
}

fn map(out: &mut Vec<u8>, n: usize) {
    out.push(0xA0 | n as u8);
}

fn structure(out: &mut Vec<u8>, fields: u8, signature: u8) {
    out.push(0xB0 | fields);
    out.push(signature);
}

fn node(out: &mut Vec<u8>, id: i64, label: &str, name: &str) {
    structure(out, 3, 0x4E);
    int(out, id);
    list(out, 1);
    string(out, label);
    map(out, 1);
    string(out, "name");
    string(out, name);
}

fn success(fields: &[&str]) -> Vec<u8> {
    let mut m = Vec::new();
    structure(&mut m, 1, 0x70);
    if fields.is_empty() {
        map(&mut m, 0);
    } else {
        map(&mut m, 1);
        string(&mut m, "fields");
        list(&mut m, fields.len());
        for f in fields {
            string(&mut m, f);
        }
    }
    m
}

fn failure(message: &str) -> Vec<u8> {
    let mut m = Vec::new();
    structure(&mut m, 1, 0x7F);
    map(&mut m, 2);
    string(&mut m, "code");
    string(&mut m, "Memgraph.ClientError.MemgraphError.MemgraphError");
    string(&mut m, "message");
    string(&mut m, message);
    m
}

fn record(write: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut m = Vec::new();
    structure(&mut m, 1, 0x71);
    write(&mut m);
    m
}

// --- The server -----------------------------------------------------------------------------------------

fn send(s: &mut TcpStream, message: &[u8]) {
    s.write_all(&(message.len() as u16).to_be_bytes()).unwrap();
    s.write_all(message).unwrap();
    s.write_all(&[0, 0]).unwrap();
}

/// A whole message, its chunks joined; `None` once the client hangs up.
fn receive(s: &mut TcpStream) -> Option<Vec<u8>> {
    let mut message = Vec::new();
    loop {
        let mut size = [0u8; 2];
        s.read_exact(&mut size).ok()?;
        let size = u16::from_be_bytes(size) as usize;
        if size == 0 {
            if message.is_empty() {
                continue;
            }
            return Some(message);
        }
        let mut chunk = vec![0; size];
        s.read_exact(&mut chunk).ok()?;
        message.extend_from_slice(&chunk);
    }
}

/// The query text of a RUN message (its first field, a string).
fn run_query(m: &[u8]) -> String {
    let (len, at) = match m[2] {
        b if b & 0xF0 == 0x80 => ((b & 0x0F) as usize, 3),
        0xD0 => (m[3] as usize, 4),
        0xD1 => (u16::from_be_bytes([m[3], m[4]]) as usize, 5),
        _ => panic!("RUN without a query"),
    };
    String::from_utf8(m[at..at + len].to_vec()).unwrap()
}

/// Answers one connection: the handshake, then each message as the script says.
fn serve(mut s: TcpStream, script: impl Fn(&str) -> Vec<Vec<u8>>) {
    let mut hello = [0u8; 20];
    if s.read_exact(&mut hello).is_err() {
        return; // a look at the port, no handshake
    }
    assert_eq!(&hello[..4], &[0x60, 0x60, 0xB0, 0x17]);
    s.write_all(&0x0104u32.to_be_bytes()).unwrap(); // Bolt 4.1
    let mut pending: Vec<Vec<u8>> = Vec::new();
    while let Some(m) = receive(&mut s) {
        match m[1] {
            0x01 | 0x0F => send(&mut s, &success(&[])), // HELLO, RESET
            0x10 => {
                let mut replies = script(&run_query(&m)).into_iter();
                let first = replies.next().unwrap();
                send(&mut s, &first);
                pending = replies.collect();
            }
            0x3F => {
                // PULL: the records, then the summary
                for r in pending.drain(..) {
                    send(&mut s, &r);
                }
                send(&mut s, &success(&[]));
            }
            0x2F => {
                // DISCARD: the summary only
                pending.clear();
                send(&mut s, &success(&[]));
            }
            0x02 => return, // GOODBYE
            other => panic!("unexpected message 0x{other:02X}"),
        }
    }
}

fn server(script: fn(&str) -> Vec<Vec<u8>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            std::thread::spawn(move || serve(s, script));
        }
    });
    format!("bolt://127.0.0.1:{port}")
}

fn script(query: &str) -> Vec<Vec<u8>> {
    match query {
        "RETURN 1" => vec![success(&["1"]), record(|m| {
            list(m, 1);
            int(m, 1);
        })],
        // A path Ada -[:KNOWS]-> Bo <-[:WORKS_AT]- Cy: the second relationship walked backwards.
        "MATCH p = (a)-[*2]-(b) RETURN p" => vec![success(&["p"]), record(|m| {
            list(m, 1);
            structure(m, 3, 0x50);
            list(m, 3);
            node(m, 1, "Person", "Ada");
            node(m, 2, "Person", "Bo");
            node(m, 3, "Person", "Cy");
            list(m, 2);
            for (id, typ) in [(10, "KNOWS"), (11, "WORKS_AT")] {
                structure(m, 3, 0x72);
                int(m, id);
                string(m, typ);
                map(m, 0);
            }
            list(m, 4);
            for i in [1, 1, -2, 2] {
                int(m, i);
            }
        })],
        "MATCH (n)-[r]->(m) RETURN n, r, m" => vec![success(&["n", "r", "m"]), record(|m| {
            list(m, 3);
            node(m, 1, "Person", "Ada");
            structure(m, 5, 0x52);
            int(m, 10);
            int(m, 1);
            int(m, 2);
            string(m, "KNOWS");
            map(m, 1);
            string(m, "since");
            int(m, 2019);
            node(m, 2, "Person", "Bo");
        })],
        _ => vec![failure("Invalid input 'NOPE'")],
    }
}

fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
    futures::executor::block_on(f)
}

#[test]
fn connects_and_reads_nodes_relationships_and_paths() {
    let uri = server(script);
    let graph = block_on(imp::connect(uri, "memgraph".into(), "".into(), "".into())).unwrap();

    let rows: serde_json::Value = serde_json::from_str(&block_on(imp::run(graph.clone(), "MATCH (n)-[r]->(m) RETURN n, r, m".into(), "".into())).unwrap()).unwrap();
    assert_eq!(rows["columns"], serde_json::json!(["m", "n", "r"]));
    let r = &rows["rows"][0][2];
    assert_eq!(r["type"], "Relationship");
    assert_eq!((r["start"].as_str(), r["end"].as_str(), r["relType"].as_str()), (Some("1"), Some("2"), Some("KNOWS")));
    assert_eq!(r["properties"]["since"], serde_json::json!({ "type": "Integer", "value": "2019" }));
    assert_eq!(rows["rows"][0][1]["labels"], serde_json::json!(["Person"]));

    let rows: serde_json::Value = serde_json::from_str(&block_on(imp::run(graph.clone(), "MATCH p = (a)-[*2]-(b) RETURN p".into(), "".into())).unwrap()).unwrap();
    let path = rows["rows"][0][0]["value"].as_array().unwrap();
    eprintln!("PATH {}", serde_json::to_string(path).unwrap());
    let rels: Vec<(String, String, String)> = path
        .iter()
        .filter(|v| v["type"] == "Relationship")
        .map(|v| (v["relType"].as_str().unwrap().into(), v["start"].as_str().unwrap().into(), v["end"].as_str().unwrap().into()))
        .collect();
    assert_eq!(rels, vec![("KNOWS".into(), "1".into(), "2".into()), ("WORKS_AT".into(), "3".into(), "2".into())]);
    assert_eq!(path.iter().filter(|v| v["type"] == "Node").count(), 3);

    let err = block_on(imp::run(graph, "NOPE".into(), "".into())).unwrap_err();
    assert!(err.contains("Invalid input 'NOPE'"), "{err}");
}

#[test]
fn reports_a_server_that_is_not_there() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let Err(err) = block_on(imp::connect(format!("bolt://127.0.0.1:{port}"), "".into(), "".into(), "".into())) else {
        panic!("connected to a closed port")
    };
    assert!(!err.is_empty());
}
