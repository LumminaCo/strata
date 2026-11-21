ARG POSTGRES_BASE=postgres:17
FROM ${POSTGRES_BASE}
COPY 10-pagila-schema.sql 20-pagila-data.sql.gz 30-strata.sql /docker-entrypoint-initdb.d/
