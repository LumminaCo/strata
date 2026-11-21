FROM mcr.microsoft.com/mssql/server:2022-latest
ADD --checksum=sha256:7e1ae09a08ee0342781bacfba9da79e91b67991aabcd1a42454a3b64eb60d626 https://github.com/microsoft/sql-server-samples/releases/download/adventureworks/AdventureWorksLT2022.bak /opt/strata-fixtures/AdventureWorksLT2022.bak
USER root
RUN chmod 0444 /opt/strata-fixtures/AdventureWorksLT2022.bak
USER mssql
