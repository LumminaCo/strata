#!/usr/bin/env bash
set -euo pipefail

sqlcmd -S mssql,1433 -U sa -C -b -l 10 -i dev/seed/mssql/strata.sql
