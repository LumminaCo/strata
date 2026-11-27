//! Headless Strata CLI and stdio MCP server entry point.

use std::collections::HashSet;

const USAGE: &str = "Usage:\n  strata mcp [--only <connection-name[,connection-name...]>]\n  strata --version\n  strata --help";

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Mcp { only: HashSet<String> },
    Version,
    Help,
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Action, String> {
    let mut arguments = args.into_iter();
    match arguments.next().as_deref() {
        Some("mcp") => {
            let mut only = HashSet::new();
            while let Some(argument) = arguments.next() {
                if argument == "--help" || argument == "-h" {
                    return Ok(Action::Help);
                }
                if argument != "--only" {
                    return Err("Use strata mcp [--only <connection-name>]".into());
                }
                let names = arguments
                    .next()
                    .ok_or_else(|| "--only requires a connection name".to_owned())?;
                let names: Vec<_> = names
                    .split(',')
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .collect();
                if names.is_empty() {
                    return Err("--only requires a connection name".into());
                }
                only.extend(names.into_iter().map(str::to_owned));
            }
            Ok(Action::Mcp { only })
        }
        Some("--version" | "-V") => {
            if arguments.next().is_some() {
                return Err("Use strata --version without extra arguments".into());
            }
            Ok(Action::Version)
        }
        Some("--help" | "-h" | "help") => Ok(Action::Help),
        Some(_) | None => Err(USAGE.into()),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match parse_args(std::env::args().skip(1))? {
        Action::Mcp { only } => tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?
            .block_on(strata_mcp::serve(only)),
        Action::Version => {
            println!("Strata {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Action::Help => {
            println!("{USAGE}");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Action, parse_args};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn parses_mcp_and_only_filters() {
        let action = parse_args(args(&[
            "mcp",
            "--only",
            "Analytics, Staging",
            "--only",
            "HR",
        ]))
        .expect("parse mcp args");
        let Action::Mcp { only } = action else {
            panic!("expected mcp action");
        };
        assert_eq!(only.len(), 3);
        assert!(only.contains("Analytics"));
        assert!(only.contains("Staging"));
        assert!(only.contains("HR"));
    }

    #[test]
    fn parses_version_and_help_flags() {
        assert_eq!(parse_args(args(&["--version"])), Ok(Action::Version));
        assert_eq!(parse_args(args(&["-V"])), Ok(Action::Version));
        assert_eq!(parse_args(args(&["--help"])), Ok(Action::Help));
        assert_eq!(parse_args(args(&["mcp", "--help"])), Ok(Action::Help));
    }

    #[test]
    fn rejects_invalid_or_missing_arguments() {
        assert!(parse_args(args(&[])).is_err());
        assert!(parse_args(args(&["unknown"])).is_err());
        assert!(parse_args(args(&["mcp", "--only"])).is_err());
        assert!(parse_args(args(&["mcp", "--only", " , "])).is_err());
        assert!(parse_args(args(&["mcp", "--bogus"])).is_err());
    }
}
