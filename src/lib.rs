//! Petal's Rust code for TSX (`petal/native`):
//!
//! - HawDB (`hawdb.rs`): on the desktops a `petal-hawdb` program Petal downloads and runs (`hawdb-helper/`),
//!   on the phones linked in. Rows come back as JSON in Petal's own value encoding (`graph/model.ts`).
//! - Petal's Bolt client (`bolt.rs`), for Memgraph and PuppyGraph.
//! - The HTTP endpoint of its MCP server (`mcp.rs`).

use nsh_core::prelude::*;

mod bolt;
mod hawdb;
mod mcp;
#[cfg(not(target_arch = "wasm32"))]
mod runtime;

/// The crate's exports (`nsh.json` `"rust"`).
#[native_module("petal/native")]
fn native(registry: &mut Registry) {
    registry
        .class::<hawdb::HawDb>()
        .class::<hawdb::HawDbHelper>()
        .class::<bolt::BoltClient>()
        .class::<mcp::McpServer>();
}
