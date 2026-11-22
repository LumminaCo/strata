SELECT k.constraint_name, k.constraint_type,
       LISTAGG('"' || REPLACE(c.column_name, '"', '""') || '"', ', ') WITHIN GROUP (ORDER BY c.position)
FROM all_constraints k
JOIN all_cons_columns c ON c.owner=k.owner AND c.constraint_name=k.constraint_name
WHERE k.owner=:1 AND k.table_name=:2 AND k.constraint_type IN ('P','U')
GROUP BY k.constraint_name, k.constraint_type
ORDER BY k.constraint_name
