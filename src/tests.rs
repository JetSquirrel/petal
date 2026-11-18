//! Probes of the Cypher Petal sends to HawDB, against a real in-memory engine.

use super::engine::Engine;

fn probe(db: &mut Engine, write: bool, p: &str, params: &str) {
    let r = if write { db.execute(p, params) } else { db.query(p, params) };
    match r {
        Ok(r) => println!("OK   {p}\n     {}", &r[..r.len().min(500)]),
        Err(e) => println!("FAIL {p}\n     {}", &e[..e.len().min(300)]),
    }
}

#[test]
#[ignore = "prints what HawDB accepts; run with --ignored --nocapture"]
fn probe_dialect() {
    let mut db = Engine::open("").unwrap();
    let writes = [
        ("CREATE (a:Person {name: 'Ada', born: 1990, petal_key: 'p:ada'})", ""),
        ("CREATE (c:Company {name: 'Acme', petal_key: 'c:acme'})", ""),
        ("UNWIND $rows AS row CREATE (n:Person) SET n = row", r#"{"rows":[{"name":"Bo","petal_key":"p:bo"}]}"#),
        ("UNWIND $rows AS row CREATE (n:Person {name: row.name, petal_key: row.petal_key})", r#"{"rows":[{"name":"Cy","petal_key":"p:cy"}]}"#),
        ("UNWIND $rows AS row CREATE (n:Person) SET n += row", r#"{"rows":[{"name":"Di","petal_key":"p:di"}]}"#),
        ("MATCH (a:Person {name: 'Ada'}), (c:Company {name: 'Acme'}) CREATE (a)-[:WORKS_AT {since: 2020}]->(c)", ""),
        ("MATCH (a:Person {name: 'Ada'}) MATCH (c:Company {name: 'Acme'}) CREATE (a)-[:WORKS_AT {since: 2020}]->(c)", ""),
        (
            "UNWIND $rows AS row MATCH (a {petal_key: row.from}) MATCH (b {petal_key: row.to}) CREATE (a)-[r:KNOWS]->(b) SET r = row.props",
            r#"{"rows":[{"from":"p:bo","to":"p:ada","props":{"w":1}}]}"#,
        ),
        (
            "UNWIND $rows AS row MATCH (a {petal_key: row.from}) MATCH (b {petal_key: row.to}) CREATE (a)-[r:KNOWS]->(b)",
            r#"{"rows":[{"from":"p:cy","to":"p:ada"}]}"#,
        ),
        (
            "UNWIND $rows AS row MATCH (a:Person) WHERE a.petal_key = row.from MATCH (b:Company) WHERE b.petal_key = row.to CREATE (a)-[r:WORKS_AT]->(b)",
            r#"{"rows":[{"from":"p:bo","to":"c:acme"}]}"#,
        ),
    ];
    for (p, params) in writes {
        probe(&mut db, true, p, params);
    }
    let reads = [
        "MATCH (n:Person) RETURN n LIMIT 5",
        "MATCH (a:Person)-[r:WORKS_AT]->(b:Company) RETURN a, r, b LIMIT 5",
        "MATCH p = (a:Person)-[r:WORKS_AT]->(b:Company) RETURN p LIMIT 5",
        "MATCH (a:Company)<-[r:WORKS_AT]-(b:Person) RETURN a, r, b LIMIT 5",
        "MATCH (a)-[r]-(b:Company) RETURN a, r, b LIMIT 5",
        "MATCH (n) RETURN DISTINCT labels(n) AS l",
        "MATCH (n) UNWIND labels(n) AS l RETURN l, count(*) AS c",
        "MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c",
        "MATCH (a)-[r]->(b) RETURN DISTINCT labels(a) AS f, type(r) AS t, labels(b) AS e",
        "CALL db.labels() YIELD label RETURN label",
        "MATCH (n) WHERE id(n) IN [0, 1] RETURN n",
        "MATCH (n) WHERE n._id IN [0, 1] RETURN n",
        "MATCH (n) WHERE elementId(n) IN ['0'] RETURN n",
        "MATCH (n)-[r]-(m) WHERE id(n) = 0 RETURN n, r, m",
        "MATCH (n)-[r]->(m) WHERE id(n) IN $ids RETURN n, r, m",
        "MATCH (n)-[r]-() WHERE id(n) = 0 RETURN type(r) AS type, startNode(r) = n AS outgoing, count(*) AS count",
        "MATCH (n)-[r]-() WHERE id(n) = 0 RETURN type(r) AS type, id(startNode(r)) = id(n) AS outgoing, count(*) AS count",
        "MATCH (n)-[r]->() WHERE id(n) = 0 RETURN type(r) AS type, count(*) AS count",
        "MATCH (n)<-[r]-() WHERE id(n) = 0 RETURN type(r) AS type, count(*) AS count",
        "MATCH (n) WHERE toLower(toString(n.name)) CONTAINS 'ad' RETURN n",
        "MATCH (n) WHERE LOWER(toString(n.name)) CONTAINS 'ad' RETURN n",
        "MATCH (n) WHERE LOWER(n.name) CONTAINS 'ad' RETURN n",
        "MATCH (n) WHERE any(k IN keys(n) WHERE toLower(toString(n[k])) CONTAINS 'ad') RETURN n",
        "MATCH (n) RETURN properties(n) AS p LIMIT 1",
        "MATCH (a)-[r]->(b) WHERE id(a) IN [0, 1, 2] AND id(b) IN [0, 1, 2] RETURN r",
        "MATCH (a)-[r]->(b) WHERE id(a) IN $ids AND id(b) IN $ids RETURN r",
        "MATCH (n:Person) RETURN count(*) AS c",
        "MATCH (n) RETURN n LIMIT 1",
    ];
    for p in reads {
        probe(&mut db, false, p, r#"{"ids":[0,1,2,3]}"#);
    }
}

#[test]
#[ignore = "prints what HawDB accepts; run with --ignored --nocapture"]
fn probe_more() {
    let mut db = Engine::open("").unwrap();
    let writes = [
        ("UNWIND $rows AS row CREATE (n:Person:Maintainer {name: row.name, key: row.key, topics: row.topics, independent: row.independent})", r#"{"rows":[{"name":"Mo","key":"p:mo","topics":["a","b"],"independent":true},{"name":"Lu","key":"p:lu","topics":null,"independent":null}]}"#),
        ("UNWIND $rows AS row CREATE (n:Project {name: row.name, key: row.key, firstRelease: row.d})", r#"{"rows":[{"name":"Lattice","key":"j:l","d":"2016-03-14"}]}"#),
        ("UNWIND $rows AS row MATCH (a:Person) WHERE a.key = row.from MATCH (b:Project) WHERE b.key = row.to CREATE (a)-[r:MAINTAINS {since: row.since}]->(b)", r#"{"rows":[{"from":"p:mo","to":"j:l","since":2019},{"from":"p:lu","to":"j:l","since":null}]}"#),
    ];
    for (p, params) in writes {
        probe(&mut db, true, p, params);
    }
    for p in [
        "MATCH (n) RETURN n",
        "MATCH ()-[r]->() RETURN r",
        "MATCH (n0:Person)-[r0:MAINTAINS]->(n1:Project)<-[r1]-(n2) RETURN n0, r0, n1, r1, n2 LIMIT 10",
        "MATCH (n0)-[r0]-(n1) WHERE id(n0) IN [0] RETURN n0, r0, n1 LIMIT 10",
        "MATCH (n)-[r]->() WHERE id(n) = 0 RETURN type(r) AS type, count(*) AS count ORDER BY count DESC",
        "MATCH (n:Maintainer) RETURN n",
    ] {
        probe(&mut db, false, p, "");
    }
}

#[test]
#[ignore = "prints what HawDB accepts; run with --ignored --nocapture"]
fn probe_labels() {
    let mut db = Engine::open("").unwrap();
    for (p, params) in [
        ("CREATE (n:Person {name: 'Mo'})", ""),
        ("MATCH (n:Person) WHERE n.name = 'Mo' SET n:Maintainer", ""),
        ("UNWIND $rows AS row CREATE (n:Person {name: row.name}) SET n:Maintainer", r#"{"rows":[{"name":"Lu"}]}"#),
        ("CREATE (n:`Person` {name: 'Ki'})", ""),
    ] {
        probe(&mut db, true, p, params);
    }
    for p in ["MATCH (n) RETURN n", "MATCH (n:Maintainer) RETURN n", "MATCH (n:Person) RETURN n", "MATCH (n:`Person`) RETURN n"] {
        probe(&mut db, false, p, "");
    }
}
