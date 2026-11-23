//! The MCP endpoint over real sockets: a client sends HTTP, the test plays TSX's part (`next`, `respond`).

use super::imp::{self, Response};
use crate::runtime::runtime;
use futures::executor::block_on;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::thread;

/// Sends `request` to the server on `port` and reads the whole response (the server closes the connection).
fn send(port: u16, request: String) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    })
}

fn post(path: &str, body: &str) -> String {
    format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len())
}

#[test]
fn hands_a_request_over_and_sends_the_answer_back() {
    let server = block_on(imp::start(0)).unwrap();
    assert!(server.port > 0);
    let client = send(server.port, post("/mcp", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#));

    let req = block_on(server.clone().next()).expect("a request");
    assert_eq!(req.method, "POST");
    assert_eq!(req.path, "/mcp");
    assert!(req.headers.iter().any(|(k, v)| k == "content-type" && v == "application/json"));
    assert_eq!(req.body, r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#);
    let json: serde_json::Value = serde_json::from_str(&req.to_json()).unwrap();
    assert_eq!(json["headers"]["host"], "127.0.0.1");

    let headers = imp::parse_headers(r#"{"Content-Type":"application/json","X-Bad\r\nInjected":"1"}"#).unwrap();
    assert!(server.respond(req.id, Response { status: 200, headers, body: r#"{"ok":true}"#.into() }));
    let answer = client.join().unwrap();
    assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"), "{answer}");
    assert!(answer.contains("Content-Type: application/json\r\n"));
    assert!(answer.contains("Content-Length: 11\r\n"));
    assert!(!answer.contains("Injected"));
    assert!(answer.ends_with("\r\n\r\n{\"ok\":true}"));
    // An answer that comes twice finds nobody waiting.
    assert!(!server.respond(req.id, Response { status: 200, headers: vec![], body: String::new() }));
    server.stop();
}

#[test]
fn reads_a_body_that_arrives_in_pieces() {
    let server = block_on(imp::start(0)).unwrap();
    let port = server.port;
    let body = "x".repeat(50_000);
    let expected = body.clone();
    let client = thread::spawn(move || {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let head = format!("POST /mcp HTTP/1.1\r\nContent-Length: {}\r\n\r\n", body.len());
        s.write_all(head.as_bytes()).unwrap();
        for piece in body.as_bytes().chunks(7000) {
            s.write_all(piece).unwrap();
            thread::sleep(std::time::Duration::from_millis(5));
        }
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    });
    let req = block_on(server.clone().next()).unwrap();
    assert_eq!(req.body, expected);
    server.respond(req.id, Response { status: 202, headers: vec![], body: String::new() });
    assert!(client.join().unwrap().starts_with("HTTP/1.1 202 Accepted"));
    server.stop();
}

#[test]
fn turns_away_what_it_cannot_read() {
    let server = block_on(imp::start(0)).unwrap();
    let chunked = send(server.port, "POST /mcp HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n".into());
    assert!(chunked.join().unwrap().starts_with("HTTP/1.1 411"));
    let big = send(server.port, "POST /mcp HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n".into());
    assert!(big.join().unwrap().starts_with("HTTP/1.1 413"));
    let garbage = send(server.port, "hello\r\n\r\n".into());
    assert!(garbage.join().unwrap().starts_with("HTTP/1.1 400"));
    server.stop();
}

#[test]
fn stopping_ends_next_and_answers_waiting_requests() {
    let server = block_on(imp::start(0)).unwrap();
    let client = send(server.port, post("/mcp", "{}"));
    let req = block_on(server.clone().next()).unwrap();
    let waiting = server.clone();
    let next = runtime().spawn(async move { waiting.next().await.is_none() });
    server.stop();
    assert!(block_on(next).unwrap(), "next resolves with nothing once stopped");
    assert!(client.join().unwrap().starts_with("HTTP/1.1 503"));
    assert!(!server.respond(req.id, Response { status: 200, headers: vec![], body: String::new() }));
}

#[test]
fn a_port_in_use_says_so() {
    let first = block_on(imp::start(0)).unwrap();
    let err = block_on(imp::start(first.port)).err().expect("the port is taken");
    assert!(err.contains("in use"), "{err}");
    first.stop();
}
