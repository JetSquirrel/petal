//! Bolt, the binary protocol of Memgraph (and of Neo4j), for TSX: `new BoltClient()`, then `connect` and
//! `query`. TSX can't speak Bolt itself (its sockets send text only), so the client is `neo4rs`, on a Tokio
//! runtime of its own; TSX awaits its tasks. Rows come back as JSON in Petal's value encoding, as HawDB's do:
//! nodes and relationships as `Node` and `Relationship`, a path as the list of its nodes and relationships.

use nsh_core::prelude::*;

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use neo4rs::{BoltList, BoltMap, BoltNode, BoltNull, BoltPath, BoltRelation, BoltString, BoltType, ConfigBuilder, Graph, query};
    use serde_json::{Map, Value as Json, json};
    use crate::runtime::runtime;
    use std::collections::HashMap;
    use std::time::Duration;

    const REACH_TIMEOUT: Duration = Duration::from_secs(5);
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
    const QUERY_TIMEOUT: Duration = Duration::from_secs(60);

    /// Runs `work` on Petal's Tokio runtime; the caller awaits it from NSH's executor.
    async fn on_runtime<T: Send + 'static>(
        limit: Duration,
        work: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
    ) -> Result<T, String> {
        let task = runtime().spawn(async move {
            match tokio::time::timeout(limit, work).await {
                Ok(r) => r,
                Err(_) => Err(format!("The database didn't answer within {} seconds.", limit.as_secs())),
            }
        });
        task.await.map_err(|e| format!("The Bolt task failed: {e}"))?
    }

    /// `host:port` of a Bolt URI (7687 when it names none).
    fn address(uri: &str) -> String {
        let rest = uri.split_once("://").map_or(uri, |(_, r)| r);
        let host = rest.split(['/', '?']).next().unwrap_or(rest);
        if host.rsplit_once(':').is_some_and(|(_, p)| p.parse::<u16>().is_ok()) { host.to_string() } else { format!("{host}:7687") }
    }

    pub async fn connect(uri: String, user: String, password: String, database: String) -> Result<Graph, String> {
        // neo4rs retries a connection that fails, for as long as the timeout lets it: a quick look first
        // reports an address with nothing listening at once.
        let addr = address(uri.trim());
        on_runtime(REACH_TIMEOUT, async move {
            tokio::net::TcpStream::connect(&addr).await.map(drop).map_err(|e| format!("Couldn't reach {addr}: {e}"))
        })
        .await?;
        on_runtime(CONNECT_TIMEOUT, async move {
            let mut config = ConfigBuilder::default().uri(uri.trim()).user(user).password(password).max_connections(4);
            if !database.trim().is_empty() {
                config = config.db(database.trim());
            }
            let graph = Graph::connect(config.build().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            // The pool connects lazily: a first statement checks the address and the credentials.
            graph.run(query("RETURN 1")).await.map_err(|e| e.to_string())?;
            Ok(graph)
        })
        .await
    }

    pub async fn run(graph: Graph, cypher: String, params: String) -> Result<String, String> {
        let params = parse_params(&params)?;
        on_runtime(QUERY_TIMEOUT, async move {
            let mut stream = graph.execute(query(&cypher).params(params)).await.map_err(|e| e.to_string())?;
            let mut columns: Vec<String> = Vec::new();
            let mut rows: Vec<Json> = Vec::new();
            while let Some(row) = stream.next().await.map_err(|e| e.to_string())? {
                let map: BoltMap = row.to().map_err(|e| e.to_string())?;
                if columns.is_empty() {
                    columns = map.value.keys().map(|k| k.value.clone()).collect();
                    columns.sort();
                }
                let row: Vec<Json> = columns
                    .iter()
                    .map(|c| map.value.get(&BoltString::new(c)).map(encode).unwrap_or_else(|| json!({ "type": "Null" })))
                    .collect();
                rows.push(Json::Array(row));
            }
            Ok(json!({ "columns": columns, "rows": rows }).to_string())
        })
        .await
    }

    fn parse_params(text: &str) -> Result<Vec<(String, BoltType)>, String> {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        match serde_json::from_str::<Json>(text).map_err(|e| format!("bad parameters: {e}"))? {
            Json::Object(map) => Ok(map.into_iter().map(|(k, v)| (k, to_bolt(v))).collect()),
            _ => Err("parameters must be a JSON object".into()),
        }
    }

    fn to_bolt(v: Json) -> BoltType {
        match v {
            Json::Null => BoltType::Null(BoltNull),
            Json::Bool(b) => b.into(),
            Json::Number(n) => match n.as_i64() {
                Some(i) => i.into(),
                None => n.as_f64().unwrap_or(f64::NAN).into(),
            },
            Json::String(s) => s.into(),
            Json::Array(a) => BoltType::List(BoltList { value: a.into_iter().map(to_bolt).collect() }),
            Json::Object(o) => {
                let mut value = HashMap::new();
                for (k, v) in o {
                    value.insert(BoltString::new(&k), to_bolt(v));
                }
                BoltType::Map(BoltMap { value })
            }
        }
    }

    fn text(kind: &str, value: String) -> Json {
        json!({ "type": "Text", "kind": kind, "value": value })
    }

    fn props(map: &BoltMap) -> Json {
        let mut out = Map::new();
        for (k, v) in &map.value {
            out.insert(k.value.clone(), encode(v));
        }
        Json::Object(out)
    }

    fn labels(list: &BoltList) -> Vec<Json> {
        list.value
            .iter()
            .filter_map(|l| match l {
                BoltType::String(s) => Some(Json::String(s.value.clone())),
                _ => None,
            })
            .collect()
    }

    fn node(n: &BoltNode) -> Json {
        json!({ "type": "Node", "id": n.id.value.to_string(), "labels": labels(&n.labels), "properties": props(&n.properties) })
    }

    fn relation(r: &BoltRelation) -> Json {
        json!({
            "type": "Relationship",
            "id": r.id.value.to_string(),
            "start": r.start_node_id.value.to_string(),
            "end": r.end_node_id.value.to_string(),
            "relType": r.typ.value,
            "properties": props(&r.properties),
        })
    }

    /// A path as the list of its nodes and relationships. Bolt sends a path's relationships without their
    /// ends: `indices` walks it, a relationship's index signed by its direction, then the next node's.
    fn path(p: &BoltPath) -> Json {
        let nodes: Vec<&BoltNode> = p.nodes.value.iter().filter_map(|n| if let BoltType::Node(n) = n { Some(n) } else { None }).collect();
        let rels: Vec<_> = p
            .rels
            .value
            .iter()
            .filter_map(|r| if let BoltType::UnboundedRelation(r) = r { Some(r) } else { None })
            .collect();
        let indices: Vec<i64> = p.indices.value.iter().filter_map(|i| if let BoltType::Integer(i) = i { Some(i.value) } else { None }).collect();
        let mut out: Vec<Json> = nodes.iter().map(|n| node(n)).collect();
        let Some(first) = nodes.first() else { return json!({ "type": "List", "value": out }) };
        let mut prev = first.id.value;
        for step in indices.chunks(2) {
            let [rel, next] = step else { break };
            let (Some(r), Some(n)) = (rels.get((rel.unsigned_abs() as usize).wrapping_sub(1)), nodes.get(*next as usize)) else {
                break;
            };
            let (start, end) = if *rel > 0 { (prev, n.id.value) } else { (n.id.value, prev) };
            out.push(json!({
                "type": "Relationship",
                "id": r.id.value.to_string(),
                "start": start.to_string(),
                "end": end.to_string(),
                "relType": r.typ.value,
                "properties": props(&r.properties),
            }));
            prev = n.id.value;
        }
        json!({ "type": "List", "value": out })
    }

    fn encode(v: &BoltType) -> Json {
        match v {
            BoltType::Null(_) => json!({ "type": "Null" }),
            BoltType::Boolean(b) => json!({ "type": "Boolean", "value": b.value }),
            BoltType::Integer(i) => json!({ "type": "Integer", "value": i.value.to_string() }),
            BoltType::Float(f) => json!({ "type": "Float", "value": f.value }),
            BoltType::String(s) => json!({ "type": "String", "value": s.value }),
            BoltType::List(l) => json!({ "type": "List", "value": l.value.iter().map(encode).collect::<Vec<_>>() }),
            BoltType::Map(m) => json!({ "type": "Map", "value": props(m) }),
            BoltType::Node(n) => node(n),
            BoltType::Relation(r) => relation(r),
            BoltType::UnboundedRelation(r) => text("Relationship", format!("[:{}]", r.typ.value)),
            BoltType::Path(p) => path(p),
            BoltType::Bytes(b) => text("Bytes", format!("{} bytes", b.value.len())),
            BoltType::Point2D(p) => text("Point", format!("POINT({} {})", p.x.value, p.y.value)),
            BoltType::Point3D(p) => text("Point", format!("POINT Z({} {} {})", p.x.value, p.y.value, p.z.value)),
            BoltType::Date(d) => temporal("Date", chrono::NaiveDate::try_from(d).map(|d| d.to_string()), v),
            BoltType::LocalDateTime(d) => temporal("LocalDateTime", chrono::NaiveDateTime::try_from(d).map(|d| d.to_string()), v),
            BoltType::DateTime(d) => temporal("DateTime", chrono::DateTime::<chrono::FixedOffset>::try_from(d).map(|d| d.to_rfc3339()), v),
            BoltType::DateTimeZoneId(d) => temporal("DateTime", chrono::NaiveDateTime::try_from(d).map(|t| format!("{t}[{}]", d.tz_id())), v),
            BoltType::LocalTime(t) => text("LocalTime", chrono::NaiveTime::from(t.clone()).to_string()),
            BoltType::Time(t) => {
                let (time, offset) = <(chrono::NaiveTime, chrono::FixedOffset)>::from(t.clone());
                text("Time", format!("{time}{offset}"))
            }
            BoltType::Duration(d) => text("Duration", format!("{:?}", std::time::Duration::from(d.clone()))),
        }
    }

    fn temporal<E>(kind: &str, value: Result<String, E>, raw: &BoltType) -> Json {
        text(kind, value.unwrap_or_else(|_| format!("{raw:?}")))
    }
}

#[cfg(target_arch = "wasm32")]
mod imp {
    pub type Graph = ();
    const UNAVAILABLE: &str = "Bolt connections need the desktop version of Petal.";
    pub async fn connect(_: String, _: String, _: String, _: String) -> Result<Graph, String> {
        Err(UNAVAILABLE.into())
    }
    pub async fn run(_: Graph, _: String, _: String) -> Result<String, String> {
        Err(UNAVAILABLE.into())
    }
}

#[cfg(not(target_arch = "wasm32"))]
type Graph = neo4rs::Graph;
#[cfg(target_arch = "wasm32")]
type Graph = imp::Graph;

/// A connection to a database that speaks Bolt: Memgraph, or Neo4j.
#[class]
pub struct BoltClient {
    graph: Option<Graph>,
}

#[class]
impl BoltClient {
    /// A client that is not connected yet: call `connect`.
    pub fn new() -> Self {
        BoltClient { graph: None }
    }

    /// Connects to `uri` (`bolt://host:7687`, `bolt+s://…`) as `user`, on `database` (`""`: the server's
    /// default), and checks the connection with a first statement.
    pub async fn connect(this: Instance<BoltClient>, uri: String, user: String, password: String, database: String) -> Result<(), String> {
        let graph = imp::connect(uri, user, password, database).await?;
        this.with_mut(|c| c.graph = Some(graph));
        Ok(())
    }

    /// Runs Cypher with `params` (a JSON object, or `""`). Resolves with `{ columns, rows }` as JSON, each
    /// value in Petal's encoding; columns are sorted by name.
    pub async fn query(this: Instance<BoltClient>, cypher: String, params: String) -> Result<String, String> {
        let graph = this.with(|c| c.graph.clone()).ok_or("Not connected.")?;
        imp::run(graph, cypher, params).await
    }

    /// Closes the connections.
    pub fn close(&mut self) {
        self.graph = None;
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
#[path = "bolt_tests.rs"]
mod tests;
