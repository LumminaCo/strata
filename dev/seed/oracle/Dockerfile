ARG ORACLE_BASE_IMAGE=gvenzl/oracle-free:23-slim
FROM ${ORACLE_BASE_IMAGE}
COPY hr/*.sql strata.sql healthcheck.sh verify.sh /opt/strata-fixtures/
COPY 10-strata.sh /container-entrypoint-initdb.d/
ENV NLS_LANG=AMERICAN_AMERICA.AL32UTF8
