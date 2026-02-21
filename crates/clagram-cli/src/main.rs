use anyhow::Result;
use clap::{CommandFactory, Parser};

#[derive(Debug, Parser)]
#[command(name = "clagram", about = "Clagram CLI", version)]
struct Cli {
    #[arg(long, global = true)]
    json: bool,
}

fn main() -> Result<()> {
    init_logging();
    let cli = Cli::parse();
    let _ = cli.json;
    let mut command = Cli::command();
    command.print_help()?;
    println!();
    Ok(())
}

fn init_logging() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .try_init();
}
