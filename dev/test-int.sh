#!/usr/bin/env bash
set -euo pipefail

PGPASSWORD="$POSTGRES_PASSWORD" psql -X -v ON_ERROR_STOP=1 -h postgres -U postgres -d pagila <<'SQL'
DO $$
BEGIN
    IF (SELECT count(*) FROM strata_demo.people) != 1000000
        OR (SELECT count(*) FROM strata_demo.type_zoo) != 2
        OR NOT EXISTS (SELECT 1 FROM public.film)
    THEN
        RAISE EXCEPTION 'PostgreSQL fixtures are incomplete';
    END IF;
END
$$;
SQL

sqlcmd -S mssql,1433 -U sa -C -b -d AdventureWorksLT2022 -Q "
    IF (SELECT count(*) FROM strata_demo.people) != 1000000
        OR (SELECT count(*) FROM strata_demo.type_zoo) != 2
        OR NOT EXISTS (SELECT 1 FROM SalesLT.Product)
    THROW 50002, 'SQL Server fixtures are incomplete', 1;
"
