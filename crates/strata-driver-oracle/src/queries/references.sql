SELECT f.constraint_name, f.owner, f.table_name, p.owner, p.table_name,
       LISTAGG('"' || REPLACE(fc.column_name,'"','""') || '"', ', ') WITHIN GROUP (ORDER BY fc.position),
       LISTAGG('"' || REPLACE(pc.column_name,'"','""') || '"', ', ') WITHIN GROUP (ORDER BY pc.position),
       f.delete_rule
FROM all_constraints f
JOIN all_constraints p ON p.owner=f.r_owner AND p.constraint_name=f.r_constraint_name
JOIN all_cons_columns fc ON fc.owner=f.owner AND fc.constraint_name=f.constraint_name
JOIN all_cons_columns pc ON pc.owner=p.owner AND pc.constraint_name=p.constraint_name AND pc.position=fc.position
WHERE f.constraint_type='R' AND ((f.owner=:1 AND f.table_name=:2) OR (p.owner=:3 AND p.table_name=:4))
GROUP BY f.constraint_name,f.owner,f.table_name,p.owner,p.table_name,f.delete_rule
ORDER BY f.constraint_name
