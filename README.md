# here2help ETL Lambda

AWS Lambda that reads the `names` table from the `here2help` Postgres database using the read-only user and replaces the tab named by `GOOGLE_SHEET_TAB` in a designated Google Sheet.

## Local Environment

Create `.env` from `.env.example` (or run `npm run setup:env`):


```text
H2H_DB_HOST=localhost
H2H_DB_PORT=5432
H2H_DB_DATABASE=here2help
H2H_DB_USER=here_readonly
H2H_DB_PASSWORD=help_readonly
H2H_DB_SSLMODE=disable

GOOGLE_SHEET_ID=your_google_sheet_id
GOOGLE_SHEET_TAB=Export
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nreplace_me\n-----END PRIVATE KEY-----\n"
```

Every variable above is required: the Lambda throws `Missing required environment variable: <name>` at startup if one is missing or blank. The only optional variable is `H2H_DB_SSL_CA`, used when `H2H_DB_SSLMODE` is `verify-ca` or `verify-full` and the server's CA is not in Node's trust store (see `.env.example`).

Share the target Google Sheet with `GOOGLE_SERVICE_ACCOUNT_EMAIL` before invoking the Lambda.

If `GOOGLE_SHEET_TAB` does not exist, the Lambda creates it before replacing the values.

## Build

```bash
npm run typecheck
npm run build
```

## Invoke Locally

```bash
npm run invoke:local
```

This requires the local Postgres container to be running and the Google Sheet credentials to be present in `.env`.

## Package

```bash
npm run package
```

This creates `lambda.zip` for upload to AWS Lambda.

Use `index.handler` as the Lambda handler.
