import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient } from "./tool-account.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ text: JSON.stringify(data, null, 2), type: "text" as const }],
    details: data,
  };
}

interface LarkResponse<T = unknown> { code?: number; msg?: string; data?: T }
type BitableRecordCreatePayload = NonNullable<
  Parameters<Lark.Client["bitable"]["appTableRecord"]["create"]>[0]
>;
type BitableRecordUpdatePayload = NonNullable<
  Parameters<Lark.Client["bitable"]["appTableRecord"]["update"]>[0]
>;
type BitableRecordFields = NonNullable<NonNullable<BitableRecordCreatePayload["data"]>["fields"]>;
type BitableRecordUpdateFields = NonNullable<
  NonNullable<BitableRecordUpdatePayload["data"]>["fields"]
>;

export class LarkApiError extends Error {
  readonly code: number;
  readonly api: string;
  readonly context?: Record<string, unknown>;
  constructor(code: number, message: string, api: string, context?: Record<string, unknown>) {
    super(`[${api}] code=${code} message=${message}`);
    this.name = "LarkApiError";
    this.code = code;
    this.api = api;
    this.context = context;
  }
}

function ensureLarkSuccess<T>(
  res: LarkResponse<T>,
  api: string,
  context?: Record<string, unknown>,
): asserts res is LarkResponse<T> & { code: 0 } {
  if (res.code !== 0) {
    throw new LarkApiError(res.code ?? -1, res.msg ?? "unknown error", api, context);
  }
}

/** Field type ID to human-readable name */
const FIELD_TYPE_NAMES: Record<number, string> = {
  1: "Text",
  1001: "CreatedTime",
  1002: "ModifiedTime",
  1003: "CreatedUser",
  1004: "ModifiedUser",
  1005: "AutoNumber",
  11: "User",
  13: "Phone",
  15: "URL",
  17: "Attachment",
  18: "SingleLink",
  19: "Lookup",
  2: "Number",
  20: "Formula",
  21: "DuplexLink",
  22: "Location",
  23: "GroupChat",
  3: "SingleSelect",
  4: "MultiSelect",
  5: "DateTime",
  7: "Checkbox",
};

// ============ Core Functions ============

/** Parse bitable URL and extract tokens */
function parseBitableUrl(url: string): { token: string; tableId?: string; isWiki: boolean } | null {
  try {
    const u = new URL(url);
    const tableId = u.searchParams.get("table") ?? undefined;

    // Wiki format: /wiki/XXXXX?table=YYY
    const wikiMatch = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (wikiMatch) {
      return { isWiki: true, tableId, token: wikiMatch[1] };
    }

    // Base format: /base/XXXXX?table=YYY
    const baseMatch = u.pathname.match(/\/base\/([A-Za-z0-9]+)/);
    if (baseMatch) {
      return { isWiki: false, tableId, token: baseMatch[1] };
    }

    return null;
  } catch {
    return null;
  }
}

/** Get app_token from wiki node_token */
async function getAppTokenFromWiki(client: Lark.Client, nodeToken: string): Promise<string> {
  const res = await client.wiki.space.getNode({
    params: { token: nodeToken },
  });
  ensureLarkSuccess(res, "wiki.space.getNode", { nodeToken });

  const node = res.data?.node;
  if (!node) {
    throw new Error("Node not found");
  }
  if (node.obj_type !== "bitable") {
    throw new Error(`Node is not a bitable (type: ${node.obj_type})`);
  }

  return node.obj_token!;
}

/** Get bitable metadata from URL (handles both /base/ and /wiki/ URLs) */
async function getBitableMeta(client: Lark.Client, url: string) {
  const parsed = parseBitableUrl(url);
  if (!parsed) {
    throw new Error("Invalid URL format. Expected /base/XXX or /wiki/XXX URL");
  }

  let appToken: string;
  if (parsed.isWiki) {
    appToken = await getAppTokenFromWiki(client, parsed.token);
  } else {
    appToken = parsed.token;
  }

  // Get bitable app info
  const res = await client.bitable.app.get({
    path: { app_token: appToken },
  });
  ensureLarkSuccess(res, "bitable.app.get", { appToken });

  // List tables if no table_id specified
  let tables: { table_id: string; name: string }[] = [];
  if (!parsed.tableId) {
    const tablesRes = await client.bitable.appTable.list({
      path: { app_token: appToken },
    });
    if (tablesRes.code === 0) {
      tables = (tablesRes.data?.items ?? []).map((t) => ({
        name: t.name!,
        table_id: t.table_id!,
      }));
    }
  }

  return {
    app_token: appToken,
    table_id: parsed.tableId,
    name: res.data?.app?.name,
    url_type: parsed.isWiki ? "wiki" : "base",
    ...(tables.length > 0 && { tables }),
    hint: parsed.tableId
      ? `Use app_token="${appToken}" and table_id="${parsed.tableId}" for other bitable tools`
      : `Use app_token="${appToken}" for other bitable tools. Select a table_id from the tables list.`,
  };
}

async function listFields(client: Lark.Client, appToken: string, tableId: string) {
  const res = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  });
  ensureLarkSuccess(res, "bitable.appTableField.list", { appToken, tableId });

  const fields = res.data?.items ?? [];
  return {
    fields: fields.map((f) => ({
      field_id: f.field_id,
      field_name: f.field_name,
      is_primary: f.is_primary,
      type: f.type,
      type_name: FIELD_TYPE_NAMES[f.type ?? 0] || `type_${f.type}`,
      ...(f.property && { property: f.property }),
    })),
    total: fields.length,
  };
}

async function listRecords(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  pageSize?: number,
  pageToken?: string,
) {
  const res = await client.bitable.appTableRecord.list({
    params: {
      page_size: pageSize ?? 100,
      ...(pageToken && { page_token: pageToken }),
    },
    path: { app_token: appToken, table_id: tableId },
  });
  ensureLarkSuccess(res, "bitable.appTableRecord.list", { appToken, pageSize, tableId });

  return {
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
    records: res.data?.items ?? [],
    total: res.data?.total,
  };
}

async function getRecord(client: Lark.Client, appToken: string, tableId: string, recordId: string) {
  const res = await client.bitable.appTableRecord.get({
    path: { app_token: appToken, record_id: recordId, table_id: tableId },
  });
  ensureLarkSuccess(res, "bitable.appTableRecord.get", { appToken, recordId, tableId });

  return {
    record: res.data?.record,
  };
}

async function createRecord(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  fields: BitableRecordFields,
) {
  const res = await client.bitable.appTableRecord.create({
    data: { fields },
    path: { app_token: appToken, table_id: tableId },
  });
  ensureLarkSuccess(res, "bitable.appTableRecord.create", { appToken, tableId });

  return {
    record: res.data?.record,
  };
}

/** Logger interface for cleanup operations */
interface CleanupLogger {
  debug: (msg: string) => void;
  warn: (msg: string) => void;
}

/** Default field types created for new Bitable tables (to be cleaned up) */
const DEFAULT_CLEANUP_FIELD_TYPES = new Set([3, 5, 17]); // SingleSelect, DateTime, Attachment

/** Clean up default placeholder rows and fields in a newly created Bitable table */
async function cleanupNewBitable(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  tableName: string,
  logger: CleanupLogger,
): Promise<{ cleanedRows: number; cleanedFields: number }> {
  let cleanedRows = 0;
  let cleanedFields = 0;

  // Step 1: Clean up default fields
  const fieldsRes = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  });

  if (fieldsRes.code === 0 && fieldsRes.data?.items) {
    // Step 1a: Rename primary field to the table name (works for both Feishu and Lark)
    const primaryField = fieldsRes.data.items.find((f) => f.is_primary);
    if (primaryField?.field_id) {
      try {
        const newFieldName = tableName.length <= 20 ? tableName : "Name";
        await client.bitable.appTableField.update({
          data: {
            field_name: newFieldName,
            type: 1,
          },
          path: {
            app_token: appToken,
            field_id: primaryField.field_id,
            table_id: tableId,
          },
        });
        cleanedFields++;
      } catch (error) {
        logger.debug(`Failed to rename primary field: ${String(error)}`);
      }
    }

    // Step 1b: Delete default placeholder fields by type (works for both Feishu and Lark)
    const defaultFieldsToDelete = fieldsRes.data.items.filter(
      (f) => !f.is_primary && DEFAULT_CLEANUP_FIELD_TYPES.has(f.type ?? 0),
    );

    for (const field of defaultFieldsToDelete) {
      if (field.field_id) {
        try {
          await client.bitable.appTableField.delete({
            path: {
              app_token: appToken,
              field_id: field.field_id,
              table_id: tableId,
            },
          });
          cleanedFields++;
        } catch (error) {
          logger.debug(`Failed to delete default field ${field.field_name}: ${String(error)}`);
        }
      }
    }
  }

  // Step 2: Delete empty placeholder rows (batch when possible)
  const recordsRes = await client.bitable.appTableRecord.list({
    params: { page_size: 100 },
    path: { app_token: appToken, table_id: tableId },
  });

  if (recordsRes.code === 0 && recordsRes.data?.items) {
    const emptyRecordIds = recordsRes.data.items
      .filter((r) => !r.fields || Object.keys(r.fields).length === 0)
      .map((r) => r.record_id)
      .filter((id): id is string => Boolean(id));

    if (emptyRecordIds.length > 0) {
      try {
        await client.bitable.appTableRecord.batchDelete({
          data: { records: emptyRecordIds },
          path: { app_token: appToken, table_id: tableId },
        });
        cleanedRows = emptyRecordIds.length;
      } catch {
        // Fallback: delete one by one if batch API is unavailable
        for (const recordId of emptyRecordIds) {
          try {
            await client.bitable.appTableRecord.delete({
              path: { app_token: appToken, record_id: recordId, table_id: tableId },
            });
            cleanedRows++;
          } catch (error) {
            logger.debug(`Failed to delete empty row ${recordId}: ${String(error)}`);
          }
        }
      }
    }
  }

  return { cleanedFields, cleanedRows };
}

async function createApp(
  client: Lark.Client,
  name: string,
  folderToken?: string,
  logger?: CleanupLogger,
) {
  const res = await client.bitable.app.create({
    data: {
      name,
      ...(folderToken && { folder_token: folderToken }),
    },
  });
  ensureLarkSuccess(res, "bitable.app.create", { folderToken, name });

  const appToken = res.data?.app?.app_token;
  if (!appToken) {
    throw new Error("Failed to create Bitable: no app_token returned");
  }

  const log: CleanupLogger = logger ?? { debug: () => {}, warn: () => {} };
  let tableId: string | undefined;
  let cleanedRows = 0;
  let cleanedFields = 0;

  try {
    const tablesRes = await client.bitable.appTable.list({
      path: { app_token: appToken },
    });
    if (tablesRes.code === 0 && tablesRes.data?.items && tablesRes.data.items.length > 0) {
      tableId = tablesRes.data.items[0].table_id ?? undefined;
      if (tableId) {
        const cleanup = await cleanupNewBitable(client, appToken, tableId, name, log);
        ({ cleanedRows } = cleanup);
        ({ cleanedFields } = cleanup);
      }
    }
  } catch (error) {
    log.debug(`Cleanup failed (non-critical): ${String(error)}`);
  }

  return {
    app_token: appToken,
    cleaned_default_fields: cleanedFields,
    cleaned_placeholder_rows: cleanedRows,
    hint: tableId
      ? `Table created. Use app_token="${appToken}" and table_id="${tableId}" for other bitable tools.`
      : "Table created. Use feishu_bitable_get_meta to get table_id and field details.",
    name: res.data?.app?.name,
    table_id: tableId,
    url: res.data?.app?.url,
  };
}

async function createField(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  fieldName: string,
  fieldType: number,
  property?: Record<string, unknown>,
) {
  const res = await client.bitable.appTableField.create({
    data: {
      field_name: fieldName,
      type: fieldType,
      ...(property && { property }),
    },
    path: { app_token: appToken, table_id: tableId },
  });
  ensureLarkSuccess(res, "bitable.appTableField.create", {
    appToken,
    fieldName,
    fieldType,
    tableId,
  });

  return {
    field_id: res.data?.field?.field_id,
    field_name: res.data?.field?.field_name,
    type: res.data?.field?.type,
    type_name: FIELD_TYPE_NAMES[res.data?.field?.type ?? 0] || `type_${res.data?.field?.type}`,
  };
}

async function updateRecord(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  recordId: string,
  fields: NonNullable<NonNullable<BitableRecordUpdatePayload["data"]>["fields"]>,
) {
  const res = await client.bitable.appTableRecord.update({
    data: { fields },
    path: { app_token: appToken, record_id: recordId, table_id: tableId },
  });
  ensureLarkSuccess(res, "bitable.appTableRecord.update", { appToken, recordId, tableId });

  return {
    record: res.data?.record,
  };
}

// ============ Schemas ============

const GetMetaSchema = Type.Object({
  url: Type.String({
    description: "Bitable URL. Supports both formats: /base/XXX?table=YYY or /wiki/XXX?table=YYY",
  }),
});

const ListFieldsSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
});

const ListRecordsSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  page_size: Type.Optional(
    Type.Number({
      description: "Number of records per page (1-500, default 100)",
      maximum: 500,
      minimum: 1,
    }),
  ),
  page_token: Type.Optional(
    Type.String({ description: "Pagination token from previous response" }),
  ),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
});

const GetRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  record_id: Type.String({ description: "Record ID to retrieve" }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
});

const CreateRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  fields: Type.Record(Type.String(), Type.Any(), {
    description:
      "Field values keyed by field name. Format by type: Text='string', Number=123, SingleSelect='Option', MultiSelect=['A','B'], DateTime=timestamp_ms, User=[{id:'ou_xxx'}], URL={text:'Display',link:'https://...'}",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
});

const CreateAppSchema = Type.Object({
  folder_token: Type.Optional(
    Type.String({
      description: "Optional folder token to place the Bitable in a specific folder",
    }),
  ),
  name: Type.String({
    description: "Name for the new Bitable application",
  }),
});

const CreateFieldSchema = Type.Object({
  app_token: Type.String({
    description:
      "Bitable app token (use feishu_bitable_get_meta to get from URL, or feishu_bitable_create_app to create new)",
  }),
  field_name: Type.String({ description: "Name for the new field" }),
  field_type: Type.Number({
    description:
      "Field type ID: 1=Text, 2=Number, 3=SingleSelect, 4=MultiSelect, 5=DateTime, 7=Checkbox, 11=User, 13=Phone, 15=URL, 17=Attachment, 18=SingleLink, 19=Lookup, 20=Formula, 21=DuplexLink, 22=Location, 23=GroupChat, 1001=CreatedTime, 1002=ModifiedTime, 1003=CreatedUser, 1004=ModifiedUser, 1005=AutoNumber",
    minimum: 1,
  }),
  property: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Field-specific properties (e.g., options for SingleSelect, format for Number)",
    }),
  ),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
});

const UpdateRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  fields: Type.Record(Type.String(), Type.Any(), {
    description: "Field values to update (same format as create_record)",
  }),
  record_id: Type.String({ description: "Record ID to update" }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
});

// ============ Tool Registration ============

export function registerFeishuBitableTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_bitable: No config available, skipping bitable tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_bitable: No Feishu accounts configured, skipping bitable tools");
    return;
  }

  interface AccountAwareParams { accountId?: string }

  const getClient = (params: AccountAwareParams | undefined, defaultAccountId?: string) =>
    createFeishuToolClient({ api, defaultAccountId, executeParams: params });

  const registerBitableTool = <TParams extends AccountAwareParams>(params: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (args: { params: TParams; defaultAccountId?: string }) => Promise<unknown>;
  }) => {
    api.registerTool(
      (ctx) => ({
        description: params.description,
        async execute(_toolCallId, rawParams) {
          try {
            return json(
              await params.execute({
                defaultAccountId: ctx.agentAccountId,
                params: rawParams as TParams,
              }),
            );
          } catch (error) {
            return json({ error: formatErrorMessage(error) });
          }
        },
        label: params.label,
        name: params.name,
        parameters: params.parameters,
      }),
      { name: params.name },
    );
  };

  registerBitableTool<{ url: string; accountId?: string }>({
    description:
      "Parse a Bitable URL and get app_token, table_id, and table list. Use this first when given a /wiki/ or /base/ URL.",
    async execute({ params, defaultAccountId }) {
      return getBitableMeta(getClient(params, defaultAccountId), params.url);
    },
    label: "Feishu Bitable Get Meta",
    name: "feishu_bitable_get_meta",
    parameters: GetMetaSchema,
  });

  registerBitableTool<{ app_token: string; table_id: string; accountId?: string }>({
    description: "List all fields (columns) in a Bitable table with their types and properties",
    async execute({ params, defaultAccountId }) {
      return listFields(getClient(params, defaultAccountId), params.app_token, params.table_id);
    },
    label: "Feishu Bitable List Fields",
    name: "feishu_bitable_list_fields",
    parameters: ListFieldsSchema,
  });

  registerBitableTool<{
    app_token: string;
    table_id: string;
    page_size?: number;
    page_token?: string;
    accountId?: string;
  }>({
    description: "List records (rows) from a Bitable table with pagination support",
    async execute({ params, defaultAccountId }) {
      return listRecords(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        params.page_size,
        params.page_token,
      );
    },
    label: "Feishu Bitable List Records",
    name: "feishu_bitable_list_records",
    parameters: ListRecordsSchema,
  });

  registerBitableTool<{
    app_token: string;
    table_id: string;
    record_id: string;
    accountId?: string;
  }>({
    description: "Get a single record by ID from a Bitable table",
    async execute({ params, defaultAccountId }) {
      return getRecord(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        params.record_id,
      );
    },
    label: "Feishu Bitable Get Record",
    name: "feishu_bitable_get_record",
    parameters: GetRecordSchema,
  });

  registerBitableTool<{
    app_token: string;
    table_id: string;
    fields: BitableRecordFields;
    accountId?: string;
  }>({
    description: "Create a new record (row) in a Bitable table",
    async execute({ params, defaultAccountId }) {
      return createRecord(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        params.fields,
      );
    },
    label: "Feishu Bitable Create Record",
    name: "feishu_bitable_create_record",
    parameters: CreateRecordSchema,
  });

  registerBitableTool<{
    app_token: string;
    table_id: string;
    record_id: string;
    fields: BitableRecordUpdateFields;
    accountId?: string;
  }>({
    description: "Update an existing record (row) in a Bitable table",
    async execute({ params, defaultAccountId }) {
      return updateRecord(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        params.record_id,
        params.fields,
      );
    },
    label: "Feishu Bitable Update Record",
    name: "feishu_bitable_update_record",
    parameters: UpdateRecordSchema,
  });

  registerBitableTool<{ name: string; folder_token?: string; accountId?: string }>({
    description: "Create a new Bitable (multidimensional table) application",
    async execute({ params, defaultAccountId }) {
      return createApp(getClient(params, defaultAccountId), params.name, params.folder_token, {
        debug: (msg) => api.logger.debug?.(msg),
        warn: (msg) => api.logger.warn?.(msg),
      });
    },
    label: "Feishu Bitable Create App",
    name: "feishu_bitable_create_app",
    parameters: CreateAppSchema,
  });

  registerBitableTool<{
    app_token: string;
    table_id: string;
    field_name: string;
    field_type: number;
    property?: Record<string, unknown>;
    accountId?: string;
  }>({
    description: "Create a new field (column) in a Bitable table",
    async execute({ params, defaultAccountId }) {
      return createField(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        params.field_name,
        params.field_type,
        params.property,
      );
    },
    label: "Feishu Bitable Create Field",
    name: "feishu_bitable_create_field",
    parameters: CreateFieldSchema,
  });

  api.logger.info?.("feishu_bitable: Registered bitable tools");
}
