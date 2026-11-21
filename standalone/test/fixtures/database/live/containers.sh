#!/bin/sh
# Starts / removes the throwaway databases for the live Mapper tests:
#   sh test/fixtures/database/live/containers.sh start   # then wait ~30 s (Oracle: ~1 min)
#   MAPPER_DB_LIVE=1 node --test test/database.test.js   # MAPPER_DB_RECORD=1 also rewrites the fixtures
#   sh test/fixtures/database/live/containers.sh stop
# The passwords are for these local containers only (see ADMIN in test/database.test.js).
# SQL Server: mcr.microsoft.com/mssql/server is amd64-only and crashes under emulation on
# Apple Silicon, so Azure SQL Edge (same engine and sys.* catalog, arm64) is used instead.
set -e
case "$1" in
start)
	docker run -d --name mapperdb-pg -e POSTGRES_PASSWORD=AdminPw_pg_7731 -p 55432:5432 postgres:16-alpine
	docker run -d --name mapperdb-mysql -e MYSQL_ROOT_PASSWORD=AdminPw_my_7731 -p 53306:3306 mysql:8.4
	docker run -d --name mapperdb-mongo -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=AdminPw_mo_7731 -p 57017:27017 mongo:7
	docker run -d --name mapperdb-oracle -e ORACLE_PASSWORD=AdminPw_or_7731 -e APP_USER=shop -e APP_USER_PASSWORD=ShopPw_or_7731 -p 51521:1521 gvenzl/oracle-free:23-slim-faststart
	if [ "$(uname -m)" = "arm64" ] || [ "$(uname -m)" = "aarch64" ]; then MSSQL_IMAGE=mcr.microsoft.com/azure-sql-edge:latest; else MSSQL_IMAGE=mcr.microsoft.com/mssql/server:2022-latest; fi
	docker run -d --name mapperdb-mssql -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=AdminPw_ms_7731!' -p 51433:1433 "$MSSQL_IMAGE"
	;;
stop)
	docker rm -f mapperdb-pg mapperdb-mysql mapperdb-mongo mapperdb-oracle mapperdb-mssql
	;;
*)
	echo "usage: $0 start|stop" >&2
	exit 2
	;;
esac
