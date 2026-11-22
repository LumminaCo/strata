SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
       pg_catalog.pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text,
       pg_catalog.col_description(a.attrelid, a.attnum)
FROM pg_catalog.pg_attribute AS a
LEFT JOIN pg_catalog.pg_attrdef AS d ON (d.adrelid, d.adnum) = (a.attrelid, a.attnum)
WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum
