// What a program may rely on from a tool, read from the schemas the assistant publishes over MCP
// instead of written by hand: written contracts drift from the tools they describe.

export interface ToolSchemas {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface RowList {
  name: string;
  fields: string[];
}

export interface Batch {
  // The argument that carries the items
  name: string;
  fields: string[];
  required: string[];
  // How many items one call takes; larger batches are split
  max: number | null;
}

export interface ToolContract {
  lists: RowList[];
  // Values of the result that are not lists, which a condition can compare
  aggregates: string[];
  params: string[];
  required: string[];
  batch: Batch | null;
}

/**
 * Reads the properties of an object schema
 *
 * @param   schema  A JSON schema
 *
 * @return  Its properties, empty when it has none
 */
function propertiesOf(schema: unknown): Record<string, Record<string, unknown>> {
  const properties = (schema as { properties?: unknown } | undefined)?.properties;

  return properties && typeof properties === "object"
    ? (properties as Record<string, Record<string, unknown>>)
    : {};
}

/**
 * Reads the required names of an object schema
 *
 * @param   schema  A JSON schema
 *
 * @return  The names
 */
function requiredOf(schema: unknown): string[] {
  const required = (schema as { required?: unknown } | undefined)?.required;

  return Array.isArray(required) ? required.filter((name) => typeof name === "string") : [];
}

/**
 * Tells whether a property is a list of objects, the shape rows and batch items have
 *
 * @param   property  A property schema
 *
 * @return  Its item schema, or null when it is something else
 */
function itemsOf(property: Record<string, unknown>): Record<string, unknown> | null {
  const types = [property.type].flat();
  const items = property.items as Record<string, unknown> | undefined;
  const itemTypes = [items?.type].flat();

  return types.includes("array") && items && itemTypes.includes("object") ? items : null;
}

/**
 * Derives the contract of a tool from its input and output schemas
 *
 * @param   tool  The tool as MCP lists it
 *
 * @return  Its lists, aggregates, parameters and batch
 */
export function contractOf(tool: ToolSchemas): ToolContract {
  const output = propertiesOf(tool.outputSchema);
  const lists: RowList[] = [];
  const aggregates: string[] = [];
  for (const [name, property] of Object.entries(output)) {
    const items = itemsOf(property);
    if (items) {
      lists.push({ name, fields: Object.keys(propertiesOf(items)) });
    } else if (![property.type].flat().some((type) => type === "array" || type === "object")) {
      aggregates.push(name);
    }
  }
  const input = propertiesOf(tool.inputSchema);
  const batchEntry = Object.entries(input).find(([, property]) => itemsOf(property) !== null);
  const batchItems = batchEntry ? itemsOf(batchEntry[1]) : null;

  return {
    lists,
    aggregates,
    params: Object.keys(input),
    required: requiredOf(tool.inputSchema),
    batch:
      batchEntry && batchItems
        ? {
            name: batchEntry[0],
            fields: Object.keys(propertiesOf(batchItems)),
            required: requiredOf(batchItems),
            max: typeof batchEntry[1].maxItems === "number" ? batchEntry[1].maxItems : null,
          }
        : null,
  };
}
