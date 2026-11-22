SELECT a.attrelid, a.attnum, pg_catalog.format_type(a.atttypid, a.atttypmod)
FROM unnest($1::oid[], $2::smallint[]) AS origin(table_oid, column_id)
JOIN pg_catalog.pg_attribute AS a ON (a.attrelid, a.attnum) = (origin.table_oid, origin.column_id)
