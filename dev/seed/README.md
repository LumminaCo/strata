# Development fixtures

Fixture containers use public sample data and synthetic edge cases. All host bindings are loopback only.

- Pagila PostgreSQL schema and data, at upstream revision `fef9675714cfba1756df4719b5e36075a7ddf90e`. The data is compressed losslessly and the original license is included. [Pagila source](https://github.com/devrimgunduz/pagila/tree/fef9675714cfba1756df4719b5e36075a7ddf90e)
- AdventureWorksLT 2022 official backup, downloaded at image build and checked against its SHA-256 digest. The SQL Server seed restores it when the fixture database is absent. [Microsoft sample databases](https://github.com/microsoft/sql-server-samples/releases/tag/adventureworks)
- Oracle Human Resources SQL scripts from `v12.2.0.1`, with the copyright and MIT license included. The wrapper installs the same HR objects on 23ai and 11g. [Oracle HR source](https://github.com/oracle-samples/db-sample-schemas/tree/v12.2.0.1/human_resources)

Strata adds the `type_zoo` and `people` tables under `strata_demo` on PostgreSQL and SQL Server, and under `HR` on Oracle. `people` contains one million deterministic records with synthetic names and Colombian cities. The development fixture checks confirm the sample schema, one million records, and both type-zoo records on each engine.
