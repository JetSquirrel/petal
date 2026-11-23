//! The HTTP side of Petal's MCP server, for TSX: `new McpServer()`, `start(port)`, then `next()` and
//! `respond(...)` for each request. TSX can't listen on a socket, so this listens on `127.0.0.1` (never another
//! interface) and hands each request over; TSX speaks MCP (JSON-RPC, the tools) and answers.
//!
//! It is HTTP/1.1 with one request per connection (`Connection: close`) and a `Content-Length` body, which
//! is what MCP clients send over Streamable HTTP. A request TSX doesn't answer within two minutes gets a 504.

use nsh_core::prelude::*;

#[cfg(not(target_arch = "wasm32"))]
pub(crate) mod imp {
    use crate::runtime::runtime;
    use serde_json::{Map, Value as Json, json};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{Notify, mpsc, oneshot};
    use tokio::task::JoinHandle;

    const MAX_HEAD: usize = 64 * 1024;
    const MAX_BODY: usize = 4 * 1024 * 1024;
    const READ_TIMEOUT: Duration = Duration::from_secs(30);
    pub(crate) const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);

    /// A request, as TSX gets it.
    pub struct Request {
        pub id: u32,
        pub method: String,
        pub path: String,
        /// Header names in lower case.
        pub headers: Vec<(String, String)>,
        pub body: String,
    }

    impl Request {
        pub fn to_json(&self) -> String {
            let mut headers = Map::new();
            for (k, v) in &self.headers {
                headers.insert(k.clone(), Json::String(v.clone()));
            }
            json!({ "id": self.id, "method": self.method, "path": self.path, "headers": headers, "body": self.body }).to_string()
        }
    }

    pub struct Response {
        pub status: u16,
        pub headers: Vec<(String, String)>,
        pub body: String,
    }

    impl Response {
        fn text(status: u16, body: &str) -> Self {
            Response { status, headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())], body: body.into() }
        }
    }

    pub struct Server {
        pub port: u16,
        inbox: tokio::sync::Mutex<mpsc::UnboundedReceiver<Request>>,
        waiting: Mutex<HashMap<u32, oneshot::Sender<Response>>>,
        accept: Mutex<Option<JoinHandle<()>>>,
        closed: AtomicBool,
        stopped: Notify,
        ids: AtomicU32,
    }

    /// Listens on `127.0.0.1:port` (`0`: a port the system picks).
    pub async fn start(port: u16) -> Result<Arc<Server>, String> {
        let task = runtime().spawn(async move {
            let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| match e.kind() {
                std::io::ErrorKind::AddrInUse => format!("Port {port} is in use. Choose another one."),
                _ => format!("Couldn't listen on port {port}: {e}"),
            })?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let (tx, rx) = mpsc::unbounded_channel();
            let server = Arc::new(Server {
                port,
                inbox: tokio::sync::Mutex::new(rx),
                waiting: Mutex::new(HashMap::new()),
                accept: Mutex::new(None),
                closed: AtomicBool::new(false),
                stopped: Notify::new(),
                ids: AtomicU32::new(1),
            });
            let s = server.clone();
            let accept = tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else { continue };
                    tokio::spawn(serve(s.clone(), stream, tx.clone()));
                }
            });
            *server.accept.lock().unwrap() = Some(accept);
            Ok::<_, String>(server)
        });
        task.await.map_err(|e| format!("The MCP task failed: {e}"))?
    }

    impl Server {
        /// The next request; `None` once the server stopped.
        pub async fn next(self: Arc<Self>) -> Option<Request> {
            let task = runtime().spawn(async move {
                let stopped = self.stopped.notified();
                tokio::pin!(stopped);
                stopped.as_mut().enable();
                if self.closed.load(Ordering::SeqCst) {
                    return None;
                }
                let mut inbox = self.inbox.lock().await;
                tokio::select! {
                    r = inbox.recv() => r,
                    _ = stopped => None,
                }
            });
            task.await.ok().flatten()
        }

        /// Answers request `id`; false when it is no longer waiting (it timed out, or its client left).
        pub fn respond(&self, id: u32, response: Response) -> bool {
            match self.waiting.lock().unwrap().remove(&id) {
                Some(tx) => tx.send(response).is_ok(),
                None => false,
            }
        }

        /// Stops listening; requests waiting for an answer get a 503.
        pub fn stop(&self) {
            self.closed.store(true, Ordering::SeqCst);
            if let Some(accept) = self.accept.lock().unwrap().take() {
                accept.abort();
            }
            self.waiting.lock().unwrap().clear();
            self.stopped.notify_waiters();
        }
    }

    async fn serve(server: Arc<Server>, mut stream: TcpStream, tx: mpsc::UnboundedSender<Request>) {
        let response = match tokio::time::timeout(READ_TIMEOUT, read_request(&mut stream)).await {
            Err(_) => Response::text(408, "The request took too long to arrive."),
            Ok(Err(response)) => response,
            Ok(Ok((method, path, headers, body))) => {
                if server.closed.load(Ordering::SeqCst) {
                    Response::text(503, "Petal's MCP server stopped.")
                } else {
                    let id = server.ids.fetch_add(1, Ordering::Relaxed);
                    let (answer, answered) = oneshot::channel();
                    server.waiting.lock().unwrap().insert(id, answer);
                    if tx.send(Request { id, method, path, headers, body }).is_err() {
                        server.waiting.lock().unwrap().remove(&id);
                        Response::text(503, "Petal's MCP server stopped.")
                    } else {
                        match tokio::time::timeout(ANSWER_TIMEOUT, answered).await {
                            Ok(Ok(r)) => r,
                            Ok(Err(_)) => Response::text(503, "Petal's MCP server stopped."),
                            Err(_) => {
                                server.waiting.lock().unwrap().remove(&id);
                                Response::text(504, "Petal didn't answer in time.")
                            }
                        }
                    }
                }
            }
        };
        let _ = write_response(&mut stream, response).await;
        let _ = stream.shutdown().await;
    }

    type Parsed = (String, String, Vec<(String, String)>, String);

    async fn read_request(stream: &mut TcpStream) -> Result<Parsed, Response> {
        let mut buf: Vec<u8> = Vec::with_capacity(4096);
        let mut chunk = [0u8; 8192];
        let head_end = loop {
            if let Some(i) = find(&buf, b"\r\n\r\n") {
                break i;
            }
            if buf.len() > MAX_HEAD {
                return Err(Response::text(431, "The request's headers are too large."));
            }
            let n = stream.read(&mut chunk).await.map_err(|_| Response::text(400, "The request couldn't be read."))?;
            if n == 0 {
                return Err(Response::text(400, "The request ended early."));
            }
            buf.extend_from_slice(&chunk[..n]);
        };
        let head = std::str::from_utf8(&buf[..head_end]).map_err(|_| Response::text(400, "The request's headers aren't text."))?;
        let mut lines = head.split("\r\n");
        let mut first = lines.next().unwrap_or("").split(' ');
        let (method, path) = match (first.next(), first.next()) {
            (Some(m), Some(p)) if !m.is_empty() && p.starts_with('/') => (m.to_string(), p.to_string()),
            _ => return Err(Response::text(400, "The request line is malformed.")),
        };
        let mut headers = Vec::new();
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
            }
        }
        let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
        if header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
            return Err(Response::text(411, "Send the body with a Content-Length."));
        }
        let length = match header("content-length") {
            Some(v) => v.parse::<usize>().map_err(|_| Response::text(400, "The Content-Length is malformed."))?,
            None => 0,
        };
        if length > MAX_BODY {
            return Err(Response::text(413, "The request's body is too large."));
        }
        if length > 0 && header("expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue")) {
            let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").await;
        }
        let mut body = buf[head_end + 4..].to_vec();
        while body.len() < length {
            let n = stream.read(&mut chunk).await.map_err(|_| Response::text(400, "The request couldn't be read."))?;
            if n == 0 {
                return Err(Response::text(400, "The request's body ended early."));
            }
            body.extend_from_slice(&chunk[..n]);
        }
        body.truncate(length);
        let body = String::from_utf8(body).map_err(|_| Response::text(400, "The request's body isn't UTF-8."))?;
        Ok((method, path, headers, body))
    }

    async fn write_response(stream: &mut TcpStream, r: Response) -> std::io::Result<()> {
        let mut out = format!("HTTP/1.1 {} {}\r\n", r.status, reason(r.status));
        for (k, v) in &r.headers {
            // A header TSX passes can't break the response apart.
            if k.contains(['\r', '\n', ':']) || v.contains(['\r', '\n']) || k.eq_ignore_ascii_case("content-length") || k.eq_ignore_ascii_case("connection") {
                continue;
            }
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", r.body.len()));
        stream.write_all(out.as_bytes()).await?;
        stream.write_all(r.body.as_bytes()).await?;
        stream.flush().await
    }

    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    fn reason(status: u16) -> &'static str {
        match status {
            200 => "OK",
            202 => "Accepted",
            204 => "No Content",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            406 => "Not Acceptable",
            408 => "Request Timeout",
            411 => "Length Required",
            413 => "Payload Too Large",
            415 => "Unsupported Media Type",
            431 => "Request Header Fields Too Large",
            500 => "Internal Server Error",
            503 => "Service Unavailable",
            504 => "Gateway Timeout",
            _ => "Status",
        }
    }

    /// Reads `respond`'s headers argument: a JSON object of strings, or `""`.
    pub fn parse_headers(text: &str) -> Result<Vec<(String, String)>, String> {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        match serde_json::from_str::<Json>(text).map_err(|e| format!("bad headers: {e}"))? {
            Json::Object(map) => Ok(map.into_iter().map(|(k, v)| (k, v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))).collect()),
            _ => Err("headers must be a JSON object".into()),
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) mod imp {
    use std::sync::Arc;

    pub const UNAVAILABLE: &str = "The MCP server needs the desktop version of Petal.";

    pub struct Request;
    impl Request {
        pub fn to_json(&self) -> String {
            String::new()
        }
    }
    pub struct Response {
        pub status: u16,
        pub headers: Vec<(String, String)>,
        pub body: String,
    }
    pub struct Server {
        pub port: u16,
    }
    pub async fn start(_port: u16) -> Result<Arc<Server>, String> {
        Err(UNAVAILABLE.into())
    }
    impl Server {
        pub async fn next(self: Arc<Self>) -> Option<Request> {
            None
        }
        pub fn respond(&self, _id: u32, _response: Response) -> bool {
            false
        }
        pub fn stop(&self) {}
    }
    pub fn parse_headers(_text: &str) -> Result<Vec<(String, String)>, String> {
        Ok(Vec::new())
    }
}

/// Petal's MCP endpoint: an HTTP server on `127.0.0.1` whose requests TSX answers.
#[class]
pub struct McpServer {
    server: Option<std::sync::Arc<imp::Server>>,
}

#[class]
impl McpServer {
    /// A server that is not listening yet: call `start`.
    pub fn new() -> Self {
        McpServer { server: None }
    }

    /// Listens on `127.0.0.1:port` (`0`: a port the system picks), stopping what it listened on before.
    /// Resolves with the port.
    pub async fn start(this: Instance<McpServer>, port: f64) -> Result<f64, String> {
        if !(0.0..=65535.0).contains(&port) || port.fract() != 0.0 {
            return Err(format!("{port} isn't a port number."));
        }
        if let Some(old) = this.with_mut(|s| s.server.take()) {
            old.stop();
        }
        let server = imp::start(port as u16).await?;
        let port = server.port;
        this.with_mut(|s| s.server = Some(server));
        Ok(port as f64)
    }

    /// The next request, as JSON: `{ id, method, path, headers, body }`, header names in lower case.
    /// Resolves with `""` once the server stopped.
    pub async fn next(this: Instance<McpServer>) -> Result<String, String> {
        let Some(server) = this.with(|s| s.server.clone()) else { return Ok(String::new()) };
        Ok(server.next().await.map(|r| r.to_json()).unwrap_or_default())
    }

    /// Answers request `id` with `status`, `headers` (a JSON object of strings, or `""`) and `body`.
    /// Returns false when the request is no longer waiting.
    pub fn respond(&self, id: f64, status: f64, headers: String, body: String) -> Result<bool, String> {
        let Some(server) = &self.server else { return Ok(false) };
        let headers = imp::parse_headers(&headers)?;
        Ok(server.respond(id as u32, imp::Response { status: status as u16, headers, body }))
    }

    /// Stops listening.
    pub fn stop(&mut self) {
        if let Some(server) = self.server.take() {
            server.stop();
        }
    }
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "mcp_tests.rs"]
mod tests;
