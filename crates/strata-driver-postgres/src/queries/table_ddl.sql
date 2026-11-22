SELECT CASE
    WHEN c.relkind = 'p' THEN ' PARTITION BY ' || pg_catalog.pg_get_partkeydef(c.oid)
    WHEN c.relkind = 'f' THEN ' SERVER ' || pg_catalog.quote_ident(s.srvname)
    ELSE NULL
END
FROM pg_catalog.pg_class AS c
LEFT JOIN pg_catalog.pg_foreign_table AS f ON f.ftrelid = c.oid
LEFT JOIN pg_catalog.pg_foreign_server AS s ON s.oid = f.ftserver
WHERE c.oid = $1::oid
