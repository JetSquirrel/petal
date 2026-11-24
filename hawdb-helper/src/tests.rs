//! The protocol, against a real in-memory engine, and the probes of the Cypher Petal sends (`probes.rs`).

#[path = "probes.rs"]
mod probes;

use super::*;

fn session(requests: &[Json]) -> Vec<Json> {
    let input: String = requests.iter().map(|r| format!("{r}\n")).collect();
    let mut out = Vec::new();
    serve(input.as_bytes(), &mut out).unwrap();
    String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[test]
fn says_who_it_is_then_opens_writes_and_reads() {
    let replies = session(&[
        json!({ "id": 1, "op": "open", "path": "" }),
        json!({ "id": 2, "op": "execute", "cypher": "CREATE (n:Person {name: $name, born: 1815})", "params": r#"{"name":"Ada"}"# }),
        json!({ "id": 3, "op": "query", "cypher": "MATCH (n:Person) RETURN n.name AS name, n.born AS born", "params": "" }),
        json!({ "id": 4, "op": "query", "cypher": "MATCH (n) RETURN n", "params": "" }),
    ]);
    assert_eq!(replies[0], json!({ "ready": true, "protocol": PROTOCOL, "version": VERSION }));
    assert_eq!(replies[1], json!({ "id": 1, "result": null }));
    assert!(replies[2].get("result").is_some(), "{}", replies[2]);
    assert_eq!(
        replies[3]["result"],
        json!({ "columns": ["name", "born"], "rows": [[{ "type": "String", "value": "Ada" }, { "type": "Integer", "value": "1815" }]] })
    );
    let node = &replies[4]["result"]["rows"][0][0];
    assert_eq!(node["type"], "Node");
    assert_eq!(node["labels"], json!(["Person"]));
    assert_eq!(node["properties"]["name"], json!({ "type": "String", "value": "Ada" }));
}

#[test]
fn errors_are_answers_and_the_session_goes_on() {
    let replies = session(&[
        json!({ "id": 1, "op": "query", "cypher": "RETURN 1", "params": "" }),
        json!({ "id": 2, "op": "open", "path": "" }),
        json!({ "id": 3, "op": "query", "cypher": "MATCH (n RETURN n", "params": "" }),
        json!({ "id": 4, "op": "query", "cypher": "MATCH (n) RETURN count(*) AS c", "params": "[1]" }),
        json!({ "id": 5, "op": "launch" }),
        json!({ "id": 6, "op": "query", "cypher": "MATCH (n) RETURN count(*) AS c", "params": "" }),
    ]);
    assert_eq!(replies[1], json!({ "id": 1, "error": "No database is open." }));
    assert!(replies[3]["error"].is_string());
    assert_eq!(replies[4], json!({ "id": 4, "error": "parameters must be a JSON object" }));
    assert_eq!(replies[5], json!({ "id": 5, "error": "unknown op \"launch\"" }));
    assert_eq!(replies[6]["result"]["rows"], json!([[{ "type": "Integer", "value": "0" }]]));
}

#[test]
fn a_bad_line_gets_an_error_without_an_id() {
    let mut out = Vec::new();
    serve("not json\n\n".as_bytes(), &mut out).unwrap();
    let lines: Vec<Json> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[1]["id"], Json::Null);
    assert!(lines[1]["error"].as_str().unwrap().starts_with("bad request"));
}

#[test]
fn a_folder_database_keeps_what_was_written() {
    let dir = std::env::temp_dir().join(format!("petal-hawdb-test-{}", std::process::id()));
    let path = dir.to_string_lossy().to_string();
    let _ = std::fs::remove_dir_all(&dir);
    session(&[
        json!({ "id": 1, "op": "open", "path": path }),
        json!({ "id": 2, "op": "execute", "cypher": "CREATE (:City {name: 'Lyon'})", "params": "" }),
    ]);
    let replies = session(&[
        json!({ "id": 1, "op": "open", "path": path }),
        json!({ "id": 2, "op": "query", "cypher": "MATCH (c:City) RETURN c.name AS name", "params": "" }),
    ]);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(replies[2]["result"]["rows"], json!([[{ "type": "String", "value": "Lyon" }]]));
}
