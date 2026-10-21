# app-spec.json — scaffold input

`scripts/scaffold.mjs` validates this file before generating anything. Full example:
`assets/app-spec.example.json`. Validate without generating: `node scripts/scaffold.mjs --spec app-spec.json --validate-only`.

## Shape

```jsonc
{
  "app": {
    "name": "product-catalog",      // lowercase, digits, hyphens; "<name>-prd" must be <= 30 chars. Immutable once deployed.
    "title": "Product Catalog",     // shown in the UI and bundle description
    "type": "node",                 // used in the resource key <type>_<app_name>_app
    "resourceKey": "..."            // optional override when a deploy template expects a different key
  },
  "environments": {                 // dev, sqa, prd are ALL required
    "dev": {
      "host": "https://<workspace-host>",
      "catalog": "products_dev",    // exact name — _qa vs _sqa typos give empty data, not errors
      "schema": "catalog_app",
      "warehouseId": "abc123",      // bare id; the bundle templates /sql/1.0/warehouses/<id>
      "readGroup": "...",           // may open the app (App CAN_USE + API read gate)
      "writeGroup": "...",          // may mutate (also admitted by the read gate)
      "rootPath": "/Workspace/Shared/apps"  // optional; never /Workspace/Users/<person>
    },
    "sqa": { ... },
    "prd": { ... }
  },
  "entities": [
    {
      "name": "product",            // snake_case; API path /api/entities/product
      "label": "Products",          // optional
      "table": "product",           // optional, defaults to name; overridable at runtime by PRODUCT_TABLE
      "key": ["product_code"],      // stable entity key -> row_uid. Keys are required and immutable after create.
      "fields": [
        { "name": "product_code", "type": "string", "maxLength": 20 },
        { "name": "status", "type": "string", "required": true, "options": { "values": ["DRAFT", "ACTIVE"] } },
        { "name": "category", "type": "string",
          "options": { "lookup": { "table": "category", "valueColumn": "category_code", "labelColumn": "category_name", "currentOnly": true } } }
      ]
    }
  ]
}
```

## Field types

| type | SQL | UI control | Notes |
|---|---|---|---|
| `string` | `STRING` | text input | `maxLength`, `required` |
| `text` | `STRING` | textarea | |
| `integer` | `INT` | number | `min`, `max`. INT, not BIGINT (BIGINT can arrive as `bigint`, which JSON cannot serialize) |
| `number` | `DOUBLE` | number | `min`, `max` |
| `boolean` | `BOOLEAN` | checkbox | |
| `date` | `DATE` | date input | always `YYYY-MM-DD` on the wire |

`options.values` → static select (validated server-side). `options.lookup` → select loaded from
`/api/entities/<name>/options/<field>` (as the user). `currentOnly: true` when the lookup table is itself bi-temporal.
A lookup table that is not one of the spec's entities must already exist in every environment — the generator lists it.

## Reserved column names

`row_uid`, `row_checksum`, `business_start_date`, `business_end_date`, `system_start_ts`, `system_end_ts`,
`is_current`, `process_id`, `source_system_cd`, `created_by`, `updated_by`, `updated_at` — the bi-temporal audit columns.

## Interview checklist (scaffold mode)

Ask only what you cannot infer; never ask for secrets.

1. App name + title. Is there an existing app with that name (then `bundle deployment bind`)?
2. Per environment: workspace host, catalog, schema, SQL warehouse id (prefer serverless), read group, write group.
   Separate workspaces per environment? Groups already synced into each workspace?
3. Entities: business key, fields, required, types, max lengths, dropdown sources (static list or lookup table).
4. Does a shared CI deploy template require an answers file / resource-key format? (→ `app.resourceKey`, preflight `--answers`)
5. Show the spec, get explicit approval, then generate.
