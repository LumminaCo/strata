#!/usr/bin/env bash
set -euo pipefail

container_switch=
if [[ "$STRATA_ORACLE_SERVICE" == FREEPDB1 ]]; then
    container_switch="ALTER SESSION SET CONTAINER=FREEPDB1;"
fi

sqlplus -s / as sysdba <<SQL
WHENEVER SQLERROR EXIT FAILURE ROLLBACK
${container_switch}
GRANT CREATE VIEW, CREATE SYNONYM, CREATE PROCEDURE, CREATE SEQUENCE TO HR;
GRANT EXECUTE ON SYS.DBMS_STATS TO HR;
EXIT
SQL

sqlplus -L -s /nolog <<SQL
WHENEVER OSERROR EXIT FAILURE ROLLBACK
WHENEVER SQLERROR EXIT FAILURE ROLLBACK
CONNECT HR/"${APP_USER_PASSWORD}"@//localhost:1521/${STRATA_ORACLE_SERVICE}
@/opt/strata-fixtures/hr_cre.sql
@/opt/strata-fixtures/hr_popul.sql
@/opt/strata-fixtures/hr_idx.sql
@/opt/strata-fixtures/hr_code.sql
@/opt/strata-fixtures/hr_comnt.sql
@/opt/strata-fixtures/hr_analz.sql
@/opt/strata-fixtures/strata.sql
EXIT
SQL
