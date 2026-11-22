SELECT datname::text
FROM pg_catalog.pg_database
WHERE datallowconn AND NOT datistemplate AND pg_catalog.has_database_privilege(oid, 'CONNECT')
ORDER BY datname
