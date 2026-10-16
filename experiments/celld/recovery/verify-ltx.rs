//! Offline verifier using the exact approved celld-ltx runtime library.
//! It never contacts AWS, starts actors, imports ownership or publishes routes.
use std::{env, fs, io::Write, process};
fn main() {
    if let Err(error) = run() { eprintln!("LTX verification failed: {error}"); process::exit(1); }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("--wake-key") {
        if args.len() != 6 || !celld_logic::cell::valid_cell_scope(&args[2]) {
            return Err("usage: --wake-key CELL EPOCH_HEX SEQUENCE DUE_MS".into());
        }
        let epoch = u64::from_str_radix(&args[3], 16)?;
        let sequence: u64 = args[4].parse()?;
        let due: i64 = args[5].parse()?;
        if args[3] != format!("{epoch:016x}") || args[4] != sequence.to_string() || due < 0 {
            return Err("invalid wake publication coordinates".into());
        }
        let id = celld_logic::wake::PublicationId { epoch, sequence };
        println!("WAKE_KEY\t{}", celld_logic::wake::entry_key(due, &args[2], id));
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("--restore-epochs") {
        if args.len() != 4 { return Err("usage: --restore-epochs LOCAL_EPOCHS NEW_SQLITE_OUTPUT".into()); }
        if std::path::Path::new(&args[3]).exists() { return Err("refusing to overwrite SQLite output".into()); }
        let mut epochs = Vec::new();
        for entry in fs::read_dir(&args[2])? {
            let entry = entry?;
            let name = entry.file_name().into_string().map_err(|_| "invalid epoch name")?;
            let epoch: u64 = name.strip_prefix('e').ok_or("invalid epoch directory")?.parse()?;
            if epoch == 0 || name != format!("e{epoch}") || !entry.file_type()?.is_dir() { return Err("invalid epoch directory".into()); }
            epochs.push((epoch, celld_ltx::FileReplicaClient::new(entry.path().to_string_lossy().into_owned())));
        }
        epochs.sort_by_key(|entry| entry.0);
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
        runtime.block_on(async {
            let chain = celld_ltx::client::epochs::EpochChain::build(epochs).await?;
            let max = chain.max_txid();
            let stats = celld_ltx::restore(&chain, &args[3], max).await?;
            println!("RESTORED\t{}\t{}\t{}", stats.objects, stats.bytes, max);
            println!("SPANS\t{}", chain.spans().iter().map(|(epoch, txid)| format!("{epoch}:{txid}")).collect::<Vec<_>>().join(","));
            Ok::<(), celld_ltx::Error>(())
        })?;
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("--restore") {
        if args.len() != 5 { return Err("usage: --restore LOCAL_REPLICA NEW_SQLITE_OUTPUT MAX_TXID_HEX".into()); }
        if std::path::Path::new(&args[3]).exists() { return Err("refusing to overwrite SQLite output".into()); }
        let txid = celld_ltx::TXID(u64::from_str_radix(&args[4], 16)?);
        let client = celld_ltx::FileReplicaClient::new(args[2].clone());
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
        let stats = runtime.block_on(celld_ltx::restore(&client, &args[3], txid))?;
        println!("RESTORED\t{}\t{}", stats.objects, stats.bytes);
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("--bundle") {
        if args.len() != 4 { return Err("usage: --bundle FILE EXISTING_NEW_OUTPUT_DIRECTORY".into()); }
        let bytes = fs::read(&args[2])?;
        if bytes.len() > 32 * 1024 * 1024 { return Err("bundle exceeds laboratory window".into()); }
        for (index, row) in celld_ltx::bundle::decode_rows(&bytes)?.iter().enumerate() {
            if row.cell.contains(['\t', '\n', '\r']) { return Err("ambiguous bundle cell identity".into()); }
            let payload = celld_ltx::bundle::slice(&bytes, row)?;
            let decoded = celld_ltx::ltx::decode_file(payload)?;
            if decoded.header.max_txid.0 != row.txid { return Err("bundle row/header TXID mismatch".into()); }
            let name = format!("entry-{index}.ltx");
            let path = std::path::Path::new(&args[3]).join(&name);
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
            file.write_all(payload)?; file.sync_all()?;
            println!("BUNDLE\t{index}\t{}\t{}\t{}\t{}\t{name}", row.cell, row.cell_epoch, decoded.header.min_txid, decoded.header.max_txid);
        }
        return Ok(());
    }
    if args.len() != 2 && args.len() != 3 { return Err("usage: verify-ltx FILE [NEW_SNAPSHOT_SQLITE_OUTPUT]".into()); }
    let bytes = fs::read(&args[1])?;
    if bytes.len() > 32 * 1024 * 1024 { return Err("LTX exceeds bounded laboratory window".into()); }
    let decoded = celld_ltx::ltx::decode_file(&bytes)?;
    println!("HEADER\t{}\t{}\t{}\t{}\t{}", decoded.header.min_txid, decoded.header.max_txid, decoded.header.page_size, decoded.header.commit, decoded.header.is_snapshot());
    if args.len() == 3 {
        let image = celld_ltx::ltx::decode_database_image(&bytes)?;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&args[2])?;
        file.write_all(&image)?; file.sync_all()?;
        println!("SQLITE_IMAGE\t{}", image.len());
    }
    Ok(())
}
