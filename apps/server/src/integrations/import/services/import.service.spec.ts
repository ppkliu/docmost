import { ImportService } from './import.service';
import * as mammoth from 'mammoth';

jest.mock('../utils/import-formatter', () => ({
  normalizeImportHtml: jest.fn((html: string) => html),
}));

jest.mock('mammoth', () => ({
  convertToHtml: jest.fn(),
}));

describe('ImportService', () => {
  let service: ImportService;

  beforeEach(() => {
    service = new ImportService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  it('processes DOCX files with the OSS mammoth converter', async () => {
    jest
      .mocked(mammoth.convertToHtml)
      .mockResolvedValue({ value: '<h1>Hello DOCX</h1>', messages: [] });

    const result = await service.processDocx(
      Buffer.from('docx'),
      'workspace-id',
      'space-id',
      'page-id',
      'user-id',
    );

    expect(mammoth.convertToHtml).toHaveBeenCalledWith({
      buffer: Buffer.from('docx'),
    });
    expect(result).toEqual(
      expect.objectContaining({
        type: 'doc',
      }),
    );
  });
});
