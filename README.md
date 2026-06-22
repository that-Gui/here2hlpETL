# here2help ETL Lambda

AWS Lambda that reads full names from the `people` tab in a designated Google Sheet, finds matching rows in the `names` table from the `here2help` Postgres database using the read-only user, and replaces the tab named by `GOOGLE_SHEET_TAB` with those matches. The export is a header row followed by the `id`, `first_name`, `last_name`, `nationality_id`, and `created_at` columns, ordered by `first_name`.

## Local Environment

Create `.env` from `.env.example` (or run `npm run setup:env`):


```text
H2H_DB_HOST=localhost
H2H_DB_PORT=5432
H2H_DB_DATABASE=here2help
H2H_DB_USER=here_readonly
H2H_DB_PASSWORD=help_readonly

GOOGLE_SHEET_ID=your_google_sheet_id
GOOGLE_SHEET_TAB=Export
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nreplace_me\n-----END PRIVATE KEY-----\n"
```

Every variable above is required: the Lambda throws `Missing required environment variable: <name>` at startup if one is missing or blank.

Share the target Google Sheet with `GOOGLE_SERVICE_ACCOUNT_EMAIL` before invoking the Lambda.

The Google Sheet must include a tab named `people`. Its first row must include a `people` or `name` header; values below that header should be full names like `Jane Smith`. The Lambda uses the first token as the first name and exports every database row whose `first_name` matches case-insensitively.

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

The database connection does not use TLS: deploy the Lambda into the same VPC subnet as the database, and on AWS RDS make sure the parameter group does not enforce SSL (`rds.force_ssl=0`).
