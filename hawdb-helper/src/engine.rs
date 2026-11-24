//! HawDB, opened in this process: parameterized Cypher in, rows out as JSON in Petal's own value encoding
//! (`graph/model.ts`): `{ "type": "Integer", "value": "42" }`, and so on. HawDB returns a node as a map
//! holding `_id` and `labels` next to its properties, and a relationship as one holding `_id`, `source_id`,
//! `target_id` and `type`; they come out as `Node` and `Relationship`.

use hawdb::{Database, Value, ValueRef};
use serde_json::{Map, Value as Json, json};
use std::collections::BTreeMap;

pub struct Engine {
    db: Database,
}

impl Engine {
    /// Opens the database in the directory `path`, creating it when it is missing; `""` opens an empty
    /// in-memory database.
    pub fn open(path: &str) -> Result<Self, String> {
        let db = if path.trim().is_empty() {
            Database::new()
        } else {
            Database::open(path.trim()).map_err(|e| e.to_string())?
        };
        Ok(Engine { db })
    }

    /// A read: `{ columns, rows }`.
    pub fn query_json(&mut self, cypher: &str, params: &str) -> Result<Json, String> {
        let params = parse_params(params)?;
        let output = self.db.query_with_params(cypher, &params).map_err(|e| e.to_string())?;
        Ok(encode(&output))
    }

    /// A write in a transaction of its own, committed before it returns; the same result as a read.
    pub fn execute_json(&mut self, cypher: &str, params: &str) -> Result<Json, String> {
        let params = parse_params(params)?;
        let mut tx = self.db.begin_transaction().map_err(|e| e.to_string())?;
        let output = tx.query_with_params(cypher, &params).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(encode(&output))
    }

    pub fn query(&mut self, cypher: &str, params: &str) -> Result<String, String> {
        self.query_json(cypher, params).map(|j| j.to_string())
    }

    pub fn execute(&mut self, cypher: &str, params: &str) -> Result<String, String> {
        self.execute_json(cypher, params).map(|j| j.to_string())
    }
}

fn encode(output: &hawdb::QueryOutput) -> Json {
    let columns = output.schema().columns().to_vec();
    let mut rows = Vec::with_capacity(output.rows.len());
    for r in 0..output.rows.len() {
        let row: Vec<Json> = (0..columns.len())
            .map(|c| output.rows.value(r, c).map(value_ref).unwrap_or_else(|| json!({ "type": "Null" })))
            .collect();
        rows.push(Json::Array(row));
    }
    json!({ "columns": columns, "rows": rows })
}

fn parse_params(text: &str) -> Result<BTreeMap<String, Value>, String> {
    if text.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    let parsed: Json = serde_json::from_str(text).map_err(|e| format!("bad parameters: {e}"))?;
    let Json::Object(map) = parsed else {
        return Err("parameters must be a JSON object".into());
    };
    Ok(map.into_iter().map(|(k, v)| (k, from_json(v))).collect())
}

fn from_json(v: Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(b),
        Json::Number(n) => n.as_i64().map(Value::Int).unwrap_or_else(|| Value::Float(n.as_f64().unwrap_or(f64::NAN))),
        Json::String(s) => Value::String(s),
        Json::Array(a) => Value::List(a.into_iter().map(from_json).collect()),
        Json::Object(o) => Value::Map(o.into_iter().map(|(k, v)| (k, from_json(v))).collect()),
    }
}

fn text(kind: &str, value: String) -> Json {
    json!({ "type": "Text", "kind": kind, "value": value })
}

fn value(v: &Value) -> Json {
    value_ref(v.as_ref())
}

fn props(map: &BTreeMap<String, Value>, skip: &[&str]) -> Json {
    let mut out = Map::new();
    for (k, v) in map {
        if !skip.contains(&k.as_str()) {
            out.insert(k.clone(), value(v));
        }
    }
    Json::Object(out)
}

fn int(map: &BTreeMap<String, Value>, key: &str) -> Option<i64> {
    match map.get(key) {
        Some(Value::Int(i)) => Some(*i),
        _ => None,
    }
}

fn value_ref(v: ValueRef<'_>) -> Json {
    match v {
        ValueRef::Null => json!({ "type": "Null" }),
        ValueRef::Bool(b) => json!({ "type": "Boolean", "value": b }),
        ValueRef::Int(i) => json!({ "type": "Integer", "value": i.to_string() }),
        ValueRef::Float(f) => json!({ "type": "Float", "value": f }),
        ValueRef::Decimal(d) => text("Decimal", d.to_string()),
        ValueRef::String(s) => json!({ "type": "String", "value": s }),
        ValueRef::Binary(b) => text("Binary", format!("{} bytes", b.len())),
        ValueRef::Vector(_) => text("Vector", v.to_owned_value().to_string()),
        ValueRef::Uuid(u) => text("UUID", u.to_string()),
        ValueRef::List(items) => json!({ "type": "List", "value": items.iter().map(value).collect::<Vec<_>>() }),
        ValueRef::Map(map) => {
            // A node or a relationship, as HawDB returns them.
            if let (Some(id), Some(Value::List(labels))) = (int(map, "_id"), map.get("labels")) {
                if !map.contains_key("source_id") {
                    let labels: Vec<Json> = labels
                        .iter()
                        .filter_map(|l| match l {
                            Value::String(s) => Some(Json::String(s.clone())),
                            _ => None,
                        })
                        .collect();
                    return json!({ "type": "Node", "id": id.to_string(), "labels": labels, "properties": props(map, &["_id", "labels"]) });
                }
            }
            if let (Some(id), Some(source), Some(target), Some(Value::String(kind))) =
                (int(map, "_id"), int(map, "source_id"), int(map, "target_id"), map.get("type"))
            {
                return json!({
                    "type": "Relationship",
                    "id": id.to_string(),
                    "start": source.to_string(),
                    "end": target.to_string(),
                    "relType": kind,
                    "properties": props(map, &["_id", "source_id", "target_id", "type"]),
                });
            }
            json!({ "type": "Map", "value": props(map, &[]) })
        }
        ValueRef::Date(d) => text("Date", d.to_string()),
        ValueRef::LocalTime(t) => text("LocalTime", t.to_string()),
        ValueRef::LocalDateTime(t) => text("LocalDateTime", t.to_string()),
        ValueRef::DateTime(t) => text("DateTime", t.to_rfc3339()),
        ValueRef::Duration(d) => text("Duration", d.to_string()),
    }
}
