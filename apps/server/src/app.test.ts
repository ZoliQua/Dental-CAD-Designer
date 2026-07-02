import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

describe('server app', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns ok with version and kernelVersion', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      version: packageJson.version,
      kernelVersion: '0.0.0',
    });
  });

  it('round-trips a case through POST then GET', async () => {
    const postResponse = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: { name: 'Molar crown, patient A' },
    });

    expect(postResponse.statusCode).toBe(201);
    const created = postResponse.json() as {
      id: string;
      name: string;
      createdAt: string;
      updatedAt: string;
      schemaVersion: number;
    };
    expect(created).toMatchObject({
      name: 'Molar crown, patient A',
      schemaVersion: 1,
    });
    expect(typeof created.id).toBe('string');
    expect(typeof created.createdAt).toBe('string');
    expect(typeof created.updatedAt).toBe('string');

    const getResponse = await app.inject({ method: 'GET', url: '/api/cases' });

    expect(getResponse.statusCode).toBe(200);
    const cases = getResponse.json() as unknown[];
    expect(Array.isArray(cases)).toBe(true);
    expect(cases).toContainEqual(created);
  });

  it('rejects POST /api/cases with a missing name with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });
});
