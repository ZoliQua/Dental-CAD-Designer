import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyCaseDocument, useCaseStore } from './caseStore';

beforeEach(() => {
  useCaseStore.setState({ document: createEmptyCaseDocument() });
});

describe('createEmptyCaseDocument', () => {
  it('produces a schema-valid, empty CaseDocument', () => {
    const doc = createEmptyCaseDocument();
    expect(doc.schemaVersion).toBe(1);
    expect(doc.meshes).toEqual([]);
    expect(doc.scene).toEqual([]);
    expect(doc.restorations).toEqual([]);
    expect(doc.history).toEqual([]);
    expect(typeof doc.id).toBe('string');
    expect(doc.id.length).toBeGreaterThan(0);
    expect(() => new Date(doc.createdAt).toISOString()).not.toThrow();
  });

  it('generates a distinct id per call', () => {
    expect(createEmptyCaseDocument().id).not.toBe(createEmptyCaseDocument().id);
  });
});

describe('useCaseStore', () => {
  it('defaults to an empty document', () => {
    expect(useCaseStore.getState().document.meshes).toEqual([]);
  });

  it('setDocument replaces the whole snapshot', () => {
    const next = { ...createEmptyCaseDocument(), id: 'fixed-id' };
    useCaseStore.getState().setDocument(next);
    expect(useCaseStore.getState().document).toBe(next);
    expect(useCaseStore.getState().document.id).toBe('fixed-id');
  });
});
