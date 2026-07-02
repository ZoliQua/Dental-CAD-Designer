// JSON schemas for every route: used by Fastify/AJV for request validation and by
// fast-json-stringify for response serialization.

export const healthResponseSchema = {
  200: {
    type: 'object',
    required: ['status', 'version', 'kernelVersion'],
    additionalProperties: false,
    properties: {
      status: { type: 'string', const: 'ok' },
      version: { type: 'string' },
      kernelVersion: { type: 'string' },
    },
  },
} as const;

const caseSummarySchema = {
  type: 'object',
  required: ['id', 'name', 'createdAt', 'updatedAt', 'schemaVersion'],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    schemaVersion: { type: 'integer' },
  },
} as const;

export const listCasesResponseSchema = {
  200: {
    type: 'array',
    items: caseSummarySchema,
  },
} as const;

export const createCaseBodySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

export const createCaseResponseSchema = {
  201: caseSummarySchema,
} as const;
