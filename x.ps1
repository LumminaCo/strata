# Run from PowerShell with Docker Desktop. Use ./x gui inside WSLg.
$ErrorActionPreference = "Stop"

function Compose {
    & docker compose @args
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose exited with code $LASTEXITCODE." }
}

function Run-Dev {
    & docker image inspect strata-dev:local *> $null
    if ($LASTEXITCODE -ne 0) { Compose build dev }
    Compose run --rm -T --no-deps dev just @args
}

function Start-Databases {
    if (!(Test-Path -LiteralPath .env -PathType Leaf)) {
        $keys = "POSTGRES_PASSWORD", "MSSQL_SA_PASSWORD", "ORACLE_PASSWORD", "ORACLE_APP_PASSWORD", "STRATA_DEV_TOKEN"
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $lines = foreach ($key in $keys) {
                # Oracle XE 11g limits passwords to 30 bytes.
                $byteCount = if ($key.StartsWith("ORACLE_")) { 10 } else { 16 }
                $bytes = New-Object byte[] $byteCount
                $random.GetBytes($bytes)
                "$key=Strata9_$([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant())"
            }
            $lines | Set-Content -LiteralPath .env -Encoding ascii
        } finally {
            $random.Dispose()
        }
    }
    Compose up -d --build --wait postgres mssql oracle
    if ($env:COMPOSE_PROFILES -split "," -contains "legacy") {
        Compose up -d --build --wait oracle11
    }
    Run-Dev seed
}

Push-Location $PSScriptRoot
try {
    switch ($args[0]) {
        "up" {
            Start-Databases
            Run-Dev install
            Compose up -d --wait devserver web
            Write-Output "Strata is running at http://localhost:5173"
        }
        "rebuild" { Compose build dev }
        "down" { Compose --profile legacy down }
        "seed" { Start-Databases }
        "test-int" {
            Start-Databases
            Run-Dev test-int
            Compose exec -T oracle /opt/strata-fixtures/verify.sh
            if ($env:COMPOSE_PROFILES -split "," -contains "legacy") { Compose exec -T oracle11 /opt/strata-fixtures/verify.sh }
        }
        "gui" { throw "Run ./x gui inside WSLg instead." }
        default { Run-Dev @args }
    }
} finally {
    Pop-Location
}
