SELECT o.object_id, s.name, o.name, CAST(RTRIM(o.type) AS nvarchar(2)),
       p.rows, CONVERT(nvarchar(max), d.value)
FROM sys.objects AS o
JOIN sys.schemas AS s ON s.schema_id = o.schema_id
OUTER APPLY (SELECT SUM(rows) AS rows FROM sys.partitions
             WHERE object_id = o.object_id AND index_id IN (0, 1)) AS p
LEFT JOIN sys.extended_properties AS d ON d.class = 1 AND d.major_id = o.object_id
     AND d.minor_id = 0 AND d.name = N'MS_Description'
WHERE o.type IN ('U','V','P','FN','TF','IF','SO')
  AND ((@P1 = N'' AND o.object_id = OBJECT_ID(@P2)) OR (s.name = @P1 AND @P2 = N''))
ORDER BY o.name
