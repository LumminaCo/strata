SELECT sc.name, r.name, u.name, rc.name
FROM sys.foreign_keys AS f
JOIN sys.foreign_key_columns AS fc ON f.object_id = fc.constraint_object_id
JOIN sys.tables AS u ON u.object_id = f.referenced_object_id
JOIN sys.schemas AS r ON r.schema_id = u.schema_id
JOIN sys.columns AS sc ON sc.object_id = f.parent_object_id AND sc.column_id = fc.parent_column_id
JOIN sys.columns AS rc ON rc.object_id = f.referenced_object_id AND rc.column_id = fc.referenced_column_id
WHERE f.parent_object_id = @P1
ORDER BY (SELECT COUNT(*) FROM sys.foreign_key_columns AS c2 WHERE c2.constraint_object_id = f.object_id),
         f.name,
         fc.constraint_column_id
