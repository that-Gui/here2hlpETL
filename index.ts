import type { Handler } from "aws-lambda";
import { google, sheets_v4 } from "googleapis";
import { Client } from "pg";

const EXPORTED_TABLE = "residents";
const NAMES_SHEET_TAB = "names";
const NAMES_HEADER_NAME = "names";
const DB_CONNECT_TIMEOUT_MS = 10_000;
const DB_STATEMENT_TIMEOUT_MS = 30_000;

const EXPORT_COLUMNS = [
  "id",
  "first_name",
  "last_name",
  "dob_day",
  "dob_month",
  "dob_year",
  "contact_mobile_number",
  "contact_telephone_number",
  "email_address",
  "uprn",
] as const;

type ExportColumn = (typeof EXPORT_COLUMNS)[number];
type DbRow = Record<ExportColumn, unknown>;
type NameLookup = {
  firstName: string;
  lastName: string;
};

type Config = {
  dbHost: string;
  dbPort: number;
  dbDatabase: string;
  dbUser: string;
  dbPassword: string;
  googleSheetId: string;
  googleSheetTab: string;
  googleServiceAccountEmail: string;
  googlePrivateKey: string;
};

type HandlerResponse = {
  ok: true;
  exportedTable: typeof EXPORTED_TABLE;
  rowCount: number;
  sheetId: string;
  sheetTab: string;
};

export const handler: Handler = async (): Promise<HandlerResponse> => {
  const config = loadConfig();
  const names = await fetchNamesFromSheet(config);
  const rows = await fetchNamesRows(config, names);

  await replaceGoogleSheetValues(config, rows);

  return {
    ok: true,
    exportedTable: EXPORTED_TABLE,
    rowCount: rows.length,
    sheetId: config.googleSheetId,
    sheetTab: config.googleSheetTab,
  };
};

function loadConfig(): Config {
  return {
    dbHost: getRequiredEnv("H2H_DB_HOST"),
    dbPort: Number(getRequiredEnv("H2H_DB_PORT")),
    dbDatabase: getRequiredEnv("H2H_DB_DATABASE"),
    dbUser: getRequiredEnv("H2H_DB_USER"),
    dbPassword: getRequiredEnv("H2H_DB_PASSWORD"),
    googleSheetId: getRequiredEnv("GOOGLE_SHEET_ID"),
    googleSheetTab: getRequiredEnv("GOOGLE_SHEET_TAB").trim(),
    googleServiceAccountEmail: getRequiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    googlePrivateKey: decodeEscapedNewlines(
      getRequiredEnv("GOOGLE_PRIVATE_KEY"),
    ),
  };
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function decodeEscapedNewlines(value: string): string {
  return value.replace(/\\n/g, "\n");
}

async function fetchNamesRows(
  config: Config,
  names: NameLookup[],
): Promise<DbRow[]> {
  if (names.length === 0) {
    return [];
  }

  const firstNames = names.map((name) => name.firstName);
  const lastNames = names.map((name) => name.lastName);

  const client = new Client({
    host: config.dbHost,
    port: config.dbPort,
    database: config.dbDatabase,
    user: config.dbUser,
    password: config.dbPassword,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
  });

  await client.connect();

  try {
    const result = await client.query<DbRow>(
      `
      SELECT
        r.id,
        r.first_name,
        r.last_name,
        r.dob_day,
        r.dob_month,
        r.dob_year,
        r.contact_mobile_number,
        r.contact_telephone_number,
        r.email_address,
        r.uprn
      FROM residents r
      JOIN unnest($1::text[], $2::text[]) AS requested_names(first_name, last_name)
        ON lower(r.first_name) = requested_names.first_name
        AND lower(r.last_name) = requested_names.last_name
      ORDER BY r.first_name, r.last_name;
    `,
      [firstNames, lastNames],
    );

    assertExportColumnsPresent(result.fields.map((field) => field.name));

    return result.rows;
  } finally {
    await client.end();
  }
}

function assertExportColumnsPresent(fieldNames: string[]): void {
  const missing = EXPORT_COLUMNS.filter(
    (column) => !fieldNames.includes(column),
  );

  if (missing.length > 0) {
    throw new Error(
      `Query result is missing expected column(s): ${missing.join(", ")}`,
    );
  }
}

async function replaceGoogleSheetValues(
  config: Config,
  rows: DbRow[],
): Promise<void> {
  const sheets = createGoogleSheetsClient(config);
  await ensureSheetTabExists(sheets, config);

  const clearRange = toSheetRange(config.googleSheetTab, "A:Z");
  const updateRange = toSheetRange(config.googleSheetTab, "A1");
  const values = rowsToSheetValues(rows);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.googleSheetId,
    range: clearRange,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.googleSheetId,
    range: updateRange,
    valueInputOption: "RAW",
    requestBody: {
      values,
    },
  });
}

async function fetchNamesFromSheet(config: Config): Promise<NameLookup[]> {
  const sheets = createGoogleSheetsClient(config);
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: config.googleSheetId,
    range: toSheetRange(NAMES_SHEET_TAB, "A:Z"),
  });

  return extractNames(result.data.values ?? []);
}

function createGoogleSheetsClient(config: Config): sheets_v4.Sheets {
  const auth = new google.auth.JWT({
    email: config.googleServiceAccountEmail,
    key: config.googlePrivateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

function extractNames(values: unknown[][]): NameLookup[] {
  const [headers, ...rows] = values;

  if (!headers) {
    return [];
  }

  const namesColumnIndex = headers.findIndex(
    (header) => normalizeSheetText(header).toLowerCase() === NAMES_HEADER_NAME,
  );

  if (namesColumnIndex === -1) {
    throw new Error(`Missing ${NAMES_SHEET_TAB} sheet header: expected "names"`);
  }

  const names = rows
    .map((row) => parseName(row[namesColumnIndex]))
    .filter((name): name is NameLookup => name !== undefined);

  return uniqueNames(names);
}

function parseName(value: unknown): NameLookup | undefined {
  const normalizedValue = normalizeSheetText(value);

  if (!normalizedValue) {
    return undefined;
  }

  const parts = normalizedValue.split(/\s+/);

  if (parts.length !== 2) {
    return undefined;
  }

  const [firstName, lastName] = parts;

  return {
    firstName: firstName.toLowerCase(),
    lastName: lastName.toLowerCase(),
  };
}

function uniqueNames(names: NameLookup[]): NameLookup[] {
  const seen = new Set<string>();

  return names.filter((name) => {
    const key = `${name.firstName}\0${name.lastName}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function normalizeSheetText(value: unknown): string {
  return String(value ?? "").trim();
}

async function ensureSheetTabExists(
  sheets: sheets_v4.Sheets,
  config: Config,
): Promise<void> {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: config.googleSheetId,
    fields: "sheets.properties.title",
  });

  const wantedTitle = normalizeSheetTitle(config.googleSheetTab);
  const sheetExists = spreadsheet.data.sheets?.some(
    (sheet) => normalizeSheetTitle(sheet.properties?.title) === wantedTitle,
  );

  if (sheetExists) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.googleSheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: config.googleSheetTab,
            },
          },
        },
      ],
    },
  });
}

// Sheets enforces tab-name uniqueness case-insensitively, so match the same
// way; trimming tolerates tabs created with stray whitespace.
function normalizeSheetTitle(
  title: string | null | undefined,
): string | undefined {
  return title?.trim().toLowerCase();
}

function rowsToSheetValues(
  rows: DbRow[],
): Array<Array<string | number | boolean>> {
  return [
    [...EXPORT_COLUMNS],
    ...rows.map((row) =>
      EXPORT_COLUMNS.map((column) => toSheetValue(row[column])),
    ),
  ];
}

function toSheetValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return JSON.stringify(value);
}

function toSheetRange(sheetTab: string, range: string): string {
  const normalizedSheetTab = sheetTab.trim();

  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalizedSheetTab)) {
    return `${normalizedSheetTab}!${range}`;
  }

  const escapedSheetTab = normalizedSheetTab.replace(/'/g, "''");

  return `'${escapedSheetTab}'!${range}`;
}
