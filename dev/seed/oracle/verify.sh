#!/usr/bin/env bash
set -euo pipefail

sqlplus -L -s /nolog <<SQL
WHENEVER SQLERROR EXIT FAILURE
CONNECT HR/"${APP_USER_PASSWORD}"@//localhost:1521/${STRATA_ORACLE_SERVICE}
DECLARE
    row_count NUMBER;
BEGIN
    SELECT COUNT(*) INTO row_count FROM people;
    IF row_count != 1000000 THEN RAISE_APPLICATION_ERROR(-20001, 'People fixture is incomplete'); END IF;
    SELECT COUNT(*) INTO row_count FROM employees;
    IF row_count = 0 THEN RAISE_APPLICATION_ERROR(-20002, 'HR fixture is incomplete'); END IF;
    SELECT COUNT(*) INTO row_count FROM type_zoo;
    IF row_count != 2 THEN RAISE_APPLICATION_ERROR(-20003, 'Type zoo is incomplete'); END IF;
END;
/
EXIT
SQL
