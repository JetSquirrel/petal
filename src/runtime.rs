//! The Tokio runtime Petal's network code runs on (Bolt connections, the MCP endpoint): one for the
//! process, made the first time it is needed. TSX awaits its tasks from NSH's executor.

use std::sync::OnceLock;
use tokio::runtime::Runtime;

pub fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("petal-io")
            .enable_all()
            .build()
            .expect("a Tokio runtime for Petal's network code")
    })
}
