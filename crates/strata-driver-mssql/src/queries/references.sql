SELECT f.name, s.name, t.name, r.name, u.name,
       STRING_AGG(CAST(QUOTENAME(sc.name) AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY fc.constraint_column_id),
       STRING_AGG(CAST(QUOTENAME(rc.name) AS nvarchar(max)), ', ') WITHIN GROUP (ORDER BY fc.constraint_column_id),
       f.delete_referential_action_desc, f.update_referential_action_desc, f.parent_object_id
FROM sys.foreign_keys AS f
JOIN sys.foreign_key_columns AS fc ON f.object_id = fc.constraint_object_id
JOIN sys.tables AS t ON t.object_id = f.parent_object_id
JOIN sys.tables AS u ON u.object_id = f.referenced_object_id
JOIN sys.schemas AS s ON s.schema_id = t.schema_id
JOIN sys.schemas AS r ON r.schema_id = u.schema_id
JOIN sys.columns AS sc ON sc.object_id = t.object_id AND sc.column_id = fc.parent_column_id
JOIN sys.columns AS rc ON rc.object_id = u.object_id AND rc.column_id = fc.referenced_column_id
WHERE f.parent_object_id = @P1 OR f.referenced_object_id = @P1
GROUP BY f.name, s.name, t.name, r.name, u.name, f.delete_referential_action_desc, f.update_referential_action_desc, f.parent_object_id
ORDER BY f.name
