const { expect } = require('chai');

const driveFolderValidators = require('../src/validators/v2/driveFolder').default;

describe('driveFolder validators', () => {
  describe('createFolder', () => {
    it('accepts a valid payload', () => {
      const { error } = driveFolderValidators.createFolder.validate({
        folder_name: 'Contracts',
        description: 'Team contracts',
        parent_folder_id: null,
      });

      expect(error).to.equal(undefined);
    });

    it('rejects payload when folder_name is missing', () => {
      const { error } = driveFolderValidators.createFolder.validate({
        description: 'Missing folder name',
      });

      expect(error).to.not.equal(undefined);
      expect(error.details[0].message).to.equal('folder_name_validation');
    });
  });

  describe('updateFolderAccess', () => {
    it('accepts valid access entries', () => {
      const { error } = driveFolderValidators.updateFolderAccess.validate({
        entries: [
          {
            user_id: '67f4c25ad7b27a11acf7d6b5',
            role: 'editor',
          },
        ],
        replace_existing: true,
      });

      expect(error).to.equal(undefined);
    });

    it('rejects empty entries list', () => {
      const { error } = driveFolderValidators.updateFolderAccess.validate({
        entries: [],
      });

      expect(error).to.not.equal(undefined);
      expect(error.details[0].message).to.equal('folder_access_entries_validation');
    });
  });

  describe('inheritFolderAccess', () => {
    it('accepts optional trigger flag', () => {
      const { error } = driveFolderValidators.inheritFolderAccess.validate({
        trigger: true,
      });

      expect(error).to.equal(undefined);
    });
  });
});
