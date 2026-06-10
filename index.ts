import type { Handler } from "aws-lambda";
import type { ConnectionOptions } from "node:tls";
import { google, sheets_v4 } from "googleapis";
import { Client } from "pg";

const EXPORTED_TABLE = "names";
const DB_CONNECT_TIMEOUT_MS = 10_000;
const DB_STATEMENT_TIMEOUT_MS = 30_000;

const EXPORT_COLUMNS = [
  "id",
  "first_name",
  "last_name",
  "nationality_id",
  "created_at",
] as const;

type ExportColumn = (typeof EXPORT_COLUMNS)[number];
type DbRow = Record<ExportColumn, unknown>;

type Config = {
  dbHost: string;
  dbPort: number;
  dbDatabase: string;
  dbUser: string;
  dbPassword: string;
  dbSslMode: string;
  dbSslCa: string | undefined;
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
  const rows = await fetchNamesRows(config);

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
    dbSslMode: getRequiredEnv("H2H_DB_SSLMODE").trim(),
    dbSslCa: getOptionalPemEnv("H2H_DB_SSL_CA"),
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

function getOptionalPemEnv(name: string): string | undefined {
  const value = process.env[name];

  if (!value || value.trim().length === 0) {
    return undefined;
  }

  return decodeEscapedNewlines(value);
}

function decodeEscapedNewlines(value: string): string {
  return value.replace(/\\n/g, "\n");
}

async function fetchNamesRows(config: Config): Promise<DbRow[]> {
  const client = new Client({
    host: config.dbHost,
    port: config.dbPort,
    database: config.dbDatabase,
    user: config.dbUser,
    password: config.dbPassword,
    ssl: getSslConfig(config.dbSslMode, config.dbSslCa),
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
  });

  await client.connect();

  try {
    const result = await client.query<DbRow>(`
      SELECT
        id,
        first_name,
        last_name,
        nationality_id,
        created_at
      FROM names
      ORDER BY first_name;
    `);

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

function getSslConfig(
  dbSslMode: string,
  dbSslCa: string | undefined,
): false | ConnectionOptions {
  const caOptions = dbSslCa === undefined ? {} : { ca: dbSslCa };

  switch (dbSslMode.toLowerCase()) {
    case "disable":
      return false;
    case "require":
      // libpq parity: encrypt the connection without verifying the server.
      return { rejectUnauthorized: false };
    case "verify-ca":
      // Chain verification without hostname checking; needs H2H_DB_SSL_CA for
      // servers (like AWS RDS) whose CA is not in Node's default trust store.
      return {
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
        ...caOptions,
      };
    case "verify-full":
      return { rejectUnauthorized: true, ...caOptions };
    default:
      throw new Error(
        `Unsupported H2H_DB_SSLMODE: "${dbSslMode}" (expected disable, require, verify-ca, or verify-full)`,
      );
  }
}

async function replaceGoogleSheetValues(
  config: Config,
  rows: DbRow[],
): Promise<void> {
  const auth = new google.auth.JWT({
    email: config.googleServiceAccountEmail,
    key: config.googlePrivateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
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
