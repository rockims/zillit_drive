const { expect } = require('chai');

const {
  ROLE_PRIORITY,
  hasMinRole,
  pickHigherRole,
} = require('../src/services/v2/driveAccessRoles');

describe('driveAccessRoles', () => {
  it('defines expected role priorities', () => {
    expect(ROLE_PRIORITY.viewer).to.equal(1);
    expect(ROLE_PRIORITY.editor).to.equal(2);
    expect(ROLE_PRIORITY.owner).to.equal(3);
  });

  it('validates minimum role checks', () => {
    expect(hasMinRole('owner', 'viewer')).to.equal(true);
    expect(hasMinRole('editor', 'viewer')).to.equal(true);
    expect(hasMinRole('viewer', 'editor')).to.equal(false);
  });

  it('picks the higher role deterministically', () => {
    expect(pickHigherRole('viewer', 'owner')).to.equal('owner');
    expect(pickHigherRole('editor', 'viewer')).to.equal('editor');
    expect(pickHigherRole('owner', 'editor')).to.equal('owner');
  });
});
