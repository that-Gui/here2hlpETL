# here2help ETL Lambda

AWS Lambda that reads full names from the `names` tab in a designated Google Sheet, finds matching rows in the `residents` table from the `here2help` Postgres database using the read-only user, and replaces the tab named by `GOOGLE_SHEET_TAB` with those matches. The export is a header row followed by the `id`, `first_name`, `last_name`, `dob_day`, `dob_month`, `dob_year`, `contact_mobile_number`, `contact_telephone_number`, `email_address`, and `uprn` columns, ordered by `first_name` and `last_name`.

## Sheet Input

The Google Sheet must include a tab named `names`. Its first row must include a `names` header.

Values below that header should contain a first name and surname separated by whitespace, like `Jane Smith`. Rows without both a first name and surname are skipped so incomplete sheet rows do not block the export.

The Lambda matches valid sheet names against `residents.first_name` and `residents.last_name` case-insensitively.

## Sheet Output

The Lambda clears and replaces the tab named by `GOOGLE_SHEET_TAB`. If that tab does not exist, the Lambda creates it.

The output contains only these columns:

```text
id
first_name
last_name
dob_day
dob_month
dob_year
contact_mobile_number
contact_telephone_number
email_address
uprn
```

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

## Local Docker Database

The local Docker Postgres database must include a production-shaped `residents` table, and the configured read-only user must have `SELECT` access to it.

The current local Docker database was updated directly in the running `here2help-postgres` container. The `residents` table includes the production columns shown below, though the Lambda currently exports only the subset listed in Sheet Output.

```text
id
first_name
last_name
dob_day
dob_month
dob_year
contact_mobile_number
contact_telephone_number
email_address
address_first_line
address_second_line
address_third_line
postcode
uprn
ward
is_pharmacist_able_to_deliver
name_address_pharmacist
gp_surgery_details
number_of_children_under_18
consent_to_share
record_status
nhs_number
```

The local table has 16 dummy residents seeded with IDs `990001` through `990016`. Their names are:

```text
Alice Anderson
Ben Bennett
Clara Cole
Daniel Davis
Eva Edwards
Farah Foster
George Green
Hannah Hill
Isaac Irving
Jasmine Jones
Kieran King
Lina Lewis
Maya Moore
Noah Nelson
Olivia Owens
Priya Patel
```

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

`npm run invoke:local` writes to the configured Google Sheet by clearing and replacing `GOOGLE_SHEET_TAB`.

## Package

```bash
npm run package
```

This creates `lambda.zip` for upload to AWS Lambda.

Use `index.handler` as the Lambda handler.

The database connection does not use TLS: deploy the Lambda into the same VPC subnet as the database, and on AWS RDS make sure the parameter group does not enforce SSL (`rds.force_ssl=0`).
