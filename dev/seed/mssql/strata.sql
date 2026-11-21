USE master;
GO

DECLARE @lock_result int;
EXEC @lock_result = sys.sp_getapplock
    @Resource = N'strata-fixture-seed',
    @LockMode = N'Exclusive',
    @LockOwner = N'Session',
    @LockTimeout = 120000;
IF @lock_result < 0 THROW 50001, 'Could not lock the SQL Server fixture.', 1;

IF DB_ID(N'AdventureWorksLT2022') IS NULL
BEGIN
    RESTORE DATABASE AdventureWorksLT2022
    FROM DISK = '/opt/strata-fixtures/AdventureWorksLT2022.bak'
    WITH MOVE 'AdventureWorksLT2022_Data' TO '/var/opt/mssql/data/AdventureWorksLT2022.mdf',
         MOVE 'AdventureWorksLT2022_Log' TO '/var/opt/mssql/data/AdventureWorksLT2022.ldf';
END;
GO

USE AdventureWorksLT2022;
GO

SET XACT_ABORT ON;
SET NOCOUNT ON;
BEGIN TRANSACTION;

IF SCHEMA_ID(N'strata_demo') IS NULL EXEC(N'CREATE SCHEMA strata_demo;');

IF OBJECT_ID(N'strata_demo.type_zoo', N'U') IS NULL
BEGIN
    CREATE TABLE strata_demo.type_zoo (
        id int PRIMARY KEY,
        exact_value decimal(38,10),
        lowest_bigint bigint,
        highest_bigint bigint,
        label nvarchar(64),
        price money,
        instant datetimeoffset,
        payload varbinary(16),
        uid uniqueidentifier
    );

    INSERT INTO strata_demo.type_zoo VALUES
        (1, 9999999999999999999999999999.9999999999, '-9223372036854775808',
         9223372036854775807, N'Muñoz · Bogotá 🤖', 1234.5678, '2026-01-20T10:30:00-05:00',
         0x00ff, 'a144e09d-e626-40bb-95ad-0560fb123456'),
        (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
END;

IF OBJECT_ID(N'strata_demo.people', N'U') IS NULL
BEGIN
    CREATE TABLE strata_demo.people (
        id int PRIMARY KEY,
        full_name nvarchar(64) NOT NULL,
        city nvarchar(32) NOT NULL,
        joined_on date NOT NULL
    );

    INSERT INTO strata_demo.people
    SELECT value,
           CONCAT(CHOOSE(1 + value % 5, N'Lucía', N'Miguel', N'Óscar', N'María José', N'Juan David'),
                  N' ', CHOOSE(1 + value % 7, N'Rincón', N'Muñoz', N'Peña', N'Pérez', N'Ibáñez', N'López', N'Cárdenas')),
           CHOOSE(1 + value % 6, N'Bogotá', N'Medellín', N'Quibdó', N'Ibagué', N'Popayán', N'Tumaco'),
           DATEADD(day, value % 2500, CONVERT(date, '20180101'))
    FROM GENERATE_SERIES(1, 1000000);
END;

COMMIT TRANSACTION;
GO
