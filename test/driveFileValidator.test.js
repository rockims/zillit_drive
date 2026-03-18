const { expect } = require('chai');

const driveFileValidators = require('../src/validators/v2/driveFile').default;

describe('driveFile validators', () => {
  describe('createFile', () => {
    it('accepts a valid payload', () => {
      const { error } = driveFileValidators.createFile.validate({
        file_name: 'CallSheet.pdf',
        folder_id: null,
        file_path: 'project-x/drive/actual/callsheet.pdf',
        description: 'Daily call sheet',
        file_type: 'document',
        file_extension: 'pdf',
        file_size: '25 KB',
        file_size_bytes: 25600,
        mime_type: 'application/pdf',
      });

      expect(error).to.equal(undefined);
    });

    it('rejects payload when file_name is missing', () => {
      const { error } = driveFileValidators.createFile.validate({
        description: 'No file name',
      });

      expect(error).to.not.equal(undefined);
      expect(error.details[0].message).to.equal('file_name_validation');
    });
  });

  describe('updateFile', () => {
    it('accepts valid update with nullable folder_id', () => {
      const { error } = driveFileValidators.updateFile.validate({
        file_id: '67f4c25ad7b27a11acf7d6b5',
        folder_id: null,
        file_name: 'Budget.xlsx',
      });

      expect(error).to.equal(undefined);
    });
  });

  describe('moveFile', () => {
    it('rejects invalid target_folder_id', () => {
      const { error } = driveFileValidators.moveFile.validate({
        target_folder_id: 'invalid-folder-id',
      });

      expect(error).to.not.equal(undefined);
      expect(error.details[0].message).to.equal('target_folder_id_validation');
    });
  });
});
