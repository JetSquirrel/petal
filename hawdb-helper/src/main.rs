//! `petal-hawdb`: see the crate's documentation (`lib.rs`). `--version` prints the version and the
//! protocol, which Petal checks after downloading the program.

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("petal-hawdb {} protocol {}", petal_hawdb::VERSION, petal_hawdb::PROTOCOL);
        return;
    }
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    if let Err(e) = petal_hawdb::serve(stdin.lock(), stdout.lock()) {
        eprintln!("petal-hawdb: {e}");
        std::process::exit(1);
    }
}
