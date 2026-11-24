//! HawDB through the `petal-hawdb` program built from this checkout (`cargo build --release` in
//! `hawdb-helper/`, which `nsh test` needs), and installing it from a gzipped download.

use super::backend::Engine;
use super::install;
use std::io::Write;

fn helper() -> String {
    let path = install::dev_path();
    assert!(
        !path.is_empty(),
        "build the HawDB helper first: cargo build --release --manifest-path hawdb-helper/Cargo.toml"
    );
    path
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("petal-native-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn runs_cypher_through_the_helper() {
    let mut db = Engine::open(&helper(), "").unwrap();
    db.execute("CREATE (n:Person {name: $name})", r#"{"name":"Ada"}"#).unwrap();
    let rows = db.query("MATCH (n:Person) RETURN n.name AS name", "").unwrap();
    assert_eq!(rows, r#"{"columns":["name"],"rows":[[{"type":"String","value":"Ada"}]]}"#);
    let err = db.query("MATCH (n RETURN n", "").unwrap_err();
    assert!(!err.is_empty());
    // The session goes on after an error.
    assert!(db.query("MATCH (n) RETURN count(*) AS c", "").unwrap().contains("Integer"));
}

#[test]
fn a_folder_is_given_back_when_the_database_closes() {
    let dir = scratch("folder");
    let path = dir.to_string_lossy().to_string();
    {
        let mut db = Engine::open(&helper(), &path).unwrap();
        db.execute("CREATE (:City {name: 'Lyon'})", "").unwrap();
    }
    let mut db = Engine::open(&helper(), &path).unwrap();
    assert!(db.query("MATCH (c:City) RETURN c.name AS name", "").unwrap().contains("Lyon"));
    drop(db);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn says_what_is_wrong_with_a_missing_helper() {
    let err = Engine::open("", "").err().unwrap();
    assert!(err.contains("isn't installed"), "{err}");
    let err = Engine::open(&scratch("nothing").join("petal-hawdb").to_string_lossy(), "").err().unwrap();
    assert!(err.starts_with("Couldn't start HawDB"), "{err}");
}

#[test]
fn installs_a_download_that_matches_its_checksum() {
    use sha2::{Digest, Sha256};
    let program = std::fs::read(helper()).unwrap();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&program).unwrap();
    let gz = gz.finish().unwrap();
    let sum: String = Sha256::digest(&gz).iter().map(|b| format!("{b:02x}")).collect();

    let dir = scratch("install");
    let dest = dir.join("0.1.0").join(format!("petal-hawdb{}", std::env::consts::EXE_SUFFIX));
    let dest = dest.to_string_lossy().to_string();

    let err = install::install(&gz, &"0".repeat(64), &dest).unwrap_err();
    assert!(err.contains("checksum"), "{err}");
    assert!(!std::path::Path::new(&dest).exists());
    assert_eq!(install::check(&dest), "");

    let version = install::install(&gz, &sum.to_uppercase(), &dest).unwrap();
    assert_eq!(version, install::check(&dest));
    assert!(!version.is_empty());
    let mut db = Engine::open(&dest, "").unwrap();
    assert!(db.query("MATCH (n) RETURN count(*) AS c", "").unwrap().contains("Integer"));
    drop(db);

    let not_gz: String = Sha256::digest(b"hello").iter().map(|b| format!("{b:02x}")).collect();
    assert!(install::install(b"hello", &not_gz, &dest).unwrap_err().contains("damaged"));
    let _ = std::fs::remove_dir_all(&dir);
}
