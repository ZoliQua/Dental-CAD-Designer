import { beforeEach, describe, expect, it } from 'vitest';
import { useImportStore, type ImportFileEntry } from './importStore';

function entry(overrides: Partial<ImportFileEntry> = {}): ImportFileEntry {
  return {
    id: 'file-1',
    name: 'scan.stl',
    phase: 'reading',
    progress: 0,
    error: null,
    meshContentHash: null,
    ...overrides,
  };
}

beforeEach(() => {
  useImportStore.setState({ files: {}, pendingUnitConfirmation: null });
});

describe('useImportStore', () => {
  it('upsertFile adds a new entry', () => {
    useImportStore.getState().upsertFile(entry());
    expect(useImportStore.getState().files['file-1']).toEqual(entry());
  });

  it('updateFile patches an existing entry without touching its id', () => {
    useImportStore.getState().upsertFile(entry());
    useImportStore.getState().updateFile('file-1', { phase: 'parsing', progress: 0.5 });
    expect(useImportStore.getState().files['file-1']).toEqual(
      entry({ phase: 'parsing', progress: 0.5 }),
    );
  });

  it('updateFile is a no-op for an unknown id', () => {
    const before = useImportStore.getState().files;
    useImportStore.getState().updateFile('missing', { phase: 'done' });
    expect(useImportStore.getState().files).toBe(before);
  });

  it('removeFile drops the entry', () => {
    useImportStore.getState().upsertFile(entry());
    useImportStore.getState().removeFile('file-1');
    expect(useImportStore.getState().files['file-1']).toBeUndefined();
  });

  it('setPendingUnitConfirmation stores and clears the pending request', () => {
    const request = {
      fileId: 'file-1',
      fileName: 'scan.stl',
      maxExtentMm: 6,
      suspectedUnit: 'cm' as const,
      suggestedFactor: 10,
    };
    useImportStore.getState().setPendingUnitConfirmation(request);
    expect(useImportStore.getState().pendingUnitConfirmation).toEqual(request);
    useImportStore.getState().setPendingUnitConfirmation(null);
    expect(useImportStore.getState().pendingUnitConfirmation).toBeNull();
  });
});
