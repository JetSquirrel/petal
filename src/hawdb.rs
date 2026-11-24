//! HawDB for TSX (`petal/native`): `new HawDb(helper, path)`, then `query` and `execute`.
//!
//! - On the desktops HawDB is not linked into Petal (it would be most of its size). It runs as
//!   `petal-hawdb` (`hawdb-helper/`), a program Petal downloads the first time HawDB is used
//!   (`HawDbHelper.install`) and talks to over its standard input and output, one JSON message per line.
//!   Each `HawDb` is one such program; it ends when Petal closes the database, quits or crashes.
//! - On iOS and Android, which don't run downloaded programs, HawDB is linked in (`petal_hawdb::Engine`).
//! - On the web there is no HawDB.
//!
//! The calls stay synchronous, as they were when HawDB ran in Petal's process: a query waits for its
//! answer, up to `QUERY_TIMEOUT`, after which Petal stops the helper.

use nsh_core::prelude::*;

#[cfg(not(any(target_arch = "wasm32", target_os = "ios", target_os = "android")))]
mod backend {
    use serde_json::{Value as Json, json};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// The helper protocol Petal speaks (`petal_hawdb::PROTOCOL`).
    pub const PROTOCOL: u64 = 1;
    const START_TIMEOUT: Duration = Duration::from_secs(15);
    const QUERY_TIMEOUT: Duration = Duration::from_secs(120);
    /// The most of the helper's error output kept for messages.
    const STDERR_KEPT: usize = 4000;

    pub struct Engine {
        child: Child,
        stdin: ChildStdin,
        lines: Receiver<String>,
        stderr: Arc<Mutex<String>>,
        next: u64,
    }

    /// A command that doesn't open a console window on Windows.
    pub fn command(program: &str) -> Command {
        #[allow(unused_mut)]
        let mut cmd = Command::new(program);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }

    impl Engine {
        pub fn open(helper: &str, path: &str) -> Result<Self, String> {
            if helper.trim().is_empty() {
                return Err("HawDB isn't installed: download it from the HawDB connection.".into());
            }
            let mut child = command(helper)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Couldn't start HawDB ({helper}): {e}"))?;
            let stdin = child.stdin.take().ok_or("HawDB's input isn't open.")?;
            let stdout = child.stdout.take().ok_or("HawDB's output isn't open.")?;
            let mut err = child.stderr.take().ok_or("HawDB's error output isn't open.")?;
            let (tx, lines) = channel();
            std::thread::Builder::new()
                .name("petal-hawdb-out".into())
                .spawn(move || {
                    for line in BufReader::new(stdout).lines() {
                        let Ok(line) = line else { break };
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                })
                .map_err(|e| e.to_string())?;
            let stderr = Arc::new(Mutex::new(String::new()));
            let kept = stderr.clone();
            std::thread::Builder::new()
                .name("petal-hawdb-err".into())
                .spawn(move || {
                    let mut buf = [0u8; 1024];
                    while let Ok(n) = err.read(&mut buf) {
                        if n == 0 {
                            break;
                        }
                        let mut s = kept.lock().unwrap();
                        s.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if s.len() > STDERR_KEPT {
                            let cut = s.len() - STDERR_KEPT;
                            let cut = (cut..s.len()).find(|&i| s.is_char_boundary(i)).unwrap_or(s.len());
                            s.drain(..cut);
                        }
                    }
                })
                .map_err(|e| e.to_string())?;
            let mut engine = Engine { child, stdin, lines, stderr, next: 1 };
            let ready = engine.receive(START_TIMEOUT)?;
            let ready: Json = serde_json::from_str(&ready).map_err(|_| format!("{helper} isn't Petal's HawDB."))?;
            if ready.get("ready") != Some(&Json::Bool(true)) {
                return Err(format!("{helper} isn't Petal's HawDB."));
            }
            let protocol = ready.get("protocol").and_then(Json::as_u64).unwrap_or(0);
            if protocol != PROTOCOL {
                return Err(format!(
                    "This HawDB speaks protocol {protocol} and this Petal speaks {PROTOCOL}: download HawDB again from the HawDB connection."
                ));
            }
            engine.call(json!({ "op": "open", "path": path.trim() }))?;
            Ok(engine)
        }

        pub fn query(&mut self, cypher: &str, params: &str) -> Result<String, String> {
            self.call(json!({ "op": "query", "cypher": cypher, "params": params })).map(|r| r.to_string())
        }

        pub fn execute(&mut self, cypher: &str, params: &str) -> Result<String, String> {
            self.call(json!({ "op": "execute", "cypher": cypher, "params": params })).map(|r| r.to_string())
        }

        fn call(&mut self, mut request: Json) -> Result<Json, String> {
            let id = self.next;
            self.next += 1;
            request["id"] = json!(id);
            writeln!(self.stdin, "{request}").and_then(|_| self.stdin.flush()).map_err(|_| self.gone())?;
            loop {
                let line = self.receive(QUERY_TIMEOUT)?;
                let Ok(mut reply) = serde_json::from_str::<Json>(&line) else { continue };
                if reply.get("id").and_then(Json::as_u64) != Some(id) {
                    continue;
                }
                if let Some(e) = reply.get("error") {
                    return Err(e.as_str().map(str::to_string).unwrap_or_else(|| e.to_string()));
                }
                return Ok(reply.get_mut("result").map(Json::take).unwrap_or(Json::Null));
            }
        }

        fn receive(&mut self, limit: Duration) -> Result<String, String> {
            match self.lines.recv_timeout(limit) {
                Ok(line) => Ok(line),
                Err(RecvTimeoutError::Timeout) => {
                    let _ = self.child.kill();
                    Err(format!("HawDB didn't answer within {} seconds, so Petal stopped it.", limit.as_secs()))
                }
                Err(RecvTimeoutError::Disconnected) => Err(self.gone()),
            }
        }

        /// Why the helper is gone: its last error output, when it wrote any.
        fn gone(&mut self) -> String {
            let _ = self.child.wait();
            let said = self.stderr.lock().map(|s| s.trim().to_string()).unwrap_or_default();
            if said.is_empty() { "HawDB stopped unexpectedly.".into() } else { format!("HawDB stopped: {said}") }
        }
    }

    impl Drop for Engine {
        fn drop(&mut self) {
            // Closing its input ends the helper; kill it in case it is stuck in a query.
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(any(target_os = "ios", target_os = "android"))]
mod backend {
    pub struct Engine(petal_hawdb::Engine);

    impl Engine {
        pub fn open(_helper: &str, path: &str) -> Result<Self, String> {
            petal_hawdb::Engine::open(path).map(Engine)
        }
        pub fn query(&mut self, cypher: &str, params: &str) -> Result<String, String> {
            self.0.query(cypher, params)
        }
        pub fn execute(&mut self, cypher: &str, params: &str) -> Result<String, String> {
            self.0.execute(cypher, params)
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod backend {
    pub struct Engine;

    const UNAVAILABLE: &str = "HawDB opens a database on this computer, which the web version of Petal can't do.";

    impl Engine {
        pub fn open(_helper: &str, _path: &str) -> Result<Self, String> {
            Err(UNAVAILABLE.into())
        }
        pub fn query(&mut self, _cypher: &str, _params: &str) -> Result<String, String> {
            Err(UNAVAILABLE.into())
        }
        pub fn execute(&mut self, _cypher: &str, _params: &str) -> Result<String, String> {
            Err(UNAVAILABLE.into())
        }
    }
}

/// A HawDB database. HawDB owns its directory while it is open, and another process can't open the same one.
#[class]
pub struct HawDb {
    engine: Option<backend::Engine>,
}

#[class]
impl HawDb {
    /// Opens the database in the directory `path`, creating it when it is missing; `""` opens an empty
    /// in-memory database. On the desktops `helper` is the path of the `petal-hawdb` program that runs it
    /// (`HawDbHelper`); the phones, which link HawDB in, don't use it.
    pub fn new(helper: String, path: String) -> Result<Self, String> {
        Ok(HawDb { engine: Some(backend::Engine::open(&helper, &path)?) })
    }

    /// Runs a read: Cypher with `params` (a JSON object, or `""`). Returns `{ columns, rows }` as JSON,
    /// each value in Petal's encoding.
    pub fn query(&mut self, cypher: String, params: String) -> Result<String, String> {
        self.engine.as_mut().ok_or("The database is closed.")?.query(&cypher, &params)
    }

    /// Runs a write in a transaction of its own, committed before it returns; the same result as `query`.
    pub fn execute(&mut self, cypher: String, params: String) -> Result<String, String> {
        self.engine.as_mut().ok_or("The database is closed.")?.execute(&cypher, &params)
    }

    /// Closes the database and gives its directory back.
    pub fn close(&mut self) {
        self.engine = None;
    }
}

#[cfg(not(any(target_arch = "wasm32", target_os = "ios", target_os = "android")))]
mod install {
    use super::backend::{PROTOCOL, command};
    use sha2::{Digest, Sha256};
    use std::io::Read;
    use std::path::Path;

    pub const KIND: &str = "download";

    /// Checks `gz` against `sha256`, unpacks it to `dest` (through a `.part` file, so a half-written
    /// program is never left at `dest`), makes it executable, and checks that it runs.
    pub fn install(gz: &[u8], sha256: &str, dest: &str) -> Result<String, String> {
        let digest = Sha256::digest(gz);
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        if !hex.eq_ignore_ascii_case(sha256.trim()) {
            return Err("The download doesn't match HawDB's checksum, so Petal didn't keep it.".into());
        }
        let mut program = Vec::new();
        flate2::read::GzDecoder::new(gz).read_to_end(&mut program).map_err(|e| format!("The download is damaged: {e}"))?;
        let dest = Path::new(dest);
        if let Some(dir) = dest.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
        }
        let part = dest.with_extension("part");
        std::fs::write(&part, &program).map_err(|e| format!("Couldn't write {}: {e}", part.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_file(dest);
        std::fs::rename(&part, dest).map_err(|e| format!("Couldn't put HawDB at {}: {e}", dest.display()))?;
        let version = check(&dest.to_string_lossy());
        if version.is_empty() {
            let _ = std::fs::remove_file(dest);
            return Err("The downloaded HawDB doesn't run on this computer.".into());
        }
        Ok(version)
    }

    /// The version of the helper at `path` when it runs and speaks this Petal's protocol, else "".
    pub fn check(path: &str) -> String {
        if path.is_empty() || !Path::new(path).is_file() {
            return String::new();
        }
        let Ok(out) = command(path).arg("--version").output() else { return String::new() };
        let text = String::from_utf8_lossy(&out.stdout);
        // "petal-hawdb 0.1.0 protocol 1"
        let mut words = text.split_whitespace();
        match (words.next(), words.next(), words.next(), words.next()) {
            (Some("petal-hawdb"), Some(version), Some("protocol"), Some(p)) if p == PROTOCOL.to_string() => version.to_string(),
            _ => String::new(),
        }
    }

    /// The helper built from this checkout (`hawdb-helper/target/…`), for `nsh run` and `nsh test`; ""
    /// in release builds, which download it.
    pub fn dev_path() -> String {
        if !cfg!(debug_assertions) {
            return String::new();
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("hawdb-helper").join("target");
        let name = format!("petal-hawdb{}", std::env::consts::EXE_SUFFIX);
        ["release", "debug"]
            .iter()
            .map(|p| root.join(p).join(&name))
            .find(|p| p.is_file())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default()
    }

    pub async fn install_async(gz: Vec<u8>, sha256: String, dest: String) -> Result<String, String> {
        let task = crate::runtime::runtime().spawn_blocking(move || install(&gz, &sha256, &dest));
        task.await.map_err(|e| format!("The install failed: {e}"))?
    }
}

#[cfg(any(target_arch = "wasm32", target_os = "ios", target_os = "android"))]
mod install {
    /// The phones link HawDB in; the web has none.
    pub const KIND: &str = if cfg!(target_arch = "wasm32") { "none" } else { "linked" };

    pub fn check(_path: &str) -> String {
        String::new()
    }
    pub fn dev_path() -> String {
        String::new()
    }
    pub async fn install_async(_gz: Vec<u8>, _sha256: String, _dest: String) -> Result<String, String> {
        Err("HawDB isn't downloaded on this platform.".into())
    }
}

/// Where HawDB comes from on this platform, and installing the `petal-hawdb` program on the desktops.
#[class]
pub struct HawDbHelper {}

#[class]
impl HawDbHelper {
    /// The helper's checks and installer; it holds nothing.
    pub fn new() -> Self {
        HawDbHelper {}
    }

    /// `"download"` on the desktops (HawDB is a program Petal downloads), `"linked"` on the phones (it is
    /// part of Petal), `"none"` on the web.
    pub fn kind(&self) -> String {
        install::KIND.to_string()
    }

    /// The helper's version when the program at `path` runs and speaks this Petal's protocol, else `""`.
    pub fn check(&self, path: String) -> String {
        install::check(&path)
    }

    /// The helper built from Petal's own checkout, which development builds use when it is there; `""`
    /// otherwise.
    pub fn dev_path(&self) -> String {
        install::dev_path()
    }

    /// Checks the gzipped program `gz` against its SHA-256 (hex), unpacks it to `dest` and checks that it
    /// runs. Resolves with its version.
    pub async fn install(this: Instance<HawDbHelper>, gz: Vec<u8>, sha256: String, dest: String) -> Result<String, String> {
        drop(this);
        install::install_async(gz, sha256, dest).await
    }
}

#[cfg(all(test, not(any(target_arch = "wasm32", target_os = "ios", target_os = "android"))))]
#[path = "hawdb_tests.rs"]
mod tests;
