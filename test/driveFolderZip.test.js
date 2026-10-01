/**
 * Folder download as .zip: owners and editors only, the folder tree kept,
 * files this person may not download left out and listed.
 */
const { expect } = require('chai');
const sinon = require('sinon');
const { PassThrough, Readable } = require('stream');
const zlib = require('zlib');

const DriveFolderZip = require('../src/services/v2/driveFolderZip').default;
const {
  safeName, uniqueNamer, effectiveRoles, planArchive,
} = require('../src/services/v2/driveFolderZip');
const DriveFolderRepository = require('../src/repositories/v2/driveFolder').default;
const DriveFolderAccessRepository = require('../src/repositories/v2/driveFolderAccess').default;
const DriveFileRepository = require('../src/repositories/v2/driveFile').default;
const DriveFileAccessRepository = require('../src/repositories/v2/driveFileAccess').default;
const DriveAccessService = require('../src/services/v2/driveAccess').default;
const driveS3 = require('../src/utils/driveS3');
const { signAccessToken } = require('../src/utils/editorJwt');

const PROJECT = '64b000000000000000000001';
const USER = '64b000000000000000000aaa';
const OTHER = '64b000000000000000000bbb';
const ROOT = '64b0000000000000000000d1';
const SUB = '64b0000000000000000000d2';
const EMPTY = '64b0000000000000000000d3';
const LOCKED = '64b0000000000000000000d4';

const folder = (id, name, parent, extra = {}) => ({
  _id: id, folder_name: name, parent_folder_id: parent, created_by: OTHER, ...extra,
});
const file = (id, name, folderId, extra = {}) => ({
  _id: `64b00000000000000000f${id}`,
  file_name: name,
  folder_id: folderId,
  created_by: OTHER,
  uploaded_by: OTHER,
  file_path: `p1/drive/${id}_${name}`,
  attachments: [{ media: `p1/drive/${id}_${name}`, bucket: 'bucket', region: 'ap-south-1' }],
  ...extra,
});

const root = folder(ROOT, 'Day 27', null);
const tree = [
  folder(SUB, 'Call sheets', ROOT),
  folder(EMPTY, 'Empty', ROOT),
  folder(LOCKED, 'Contracts', ROOT),
];
const files = [
  file('001', 'Budget.xlsx', ROOT),
  file('002', 'notes.md', SUB),
  file('003', 'deal.pdf', LOCKED),
];

// A streamed zip keeps its sizes in the central directory at the end.
const readZip = (buffer) => {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = {};
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.slice(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.slice(start, start + size);
    entries[name] = { stored: method === 0, text: (method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8') };
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return entries;
};

const plan = (overrides = {}) => planArchive({
  root,
  rootRole: 'editor',
  folders: tree,
  files,
  roleByFolderId: new Map(),
  fileAccessById: new Map(),
  userId: USER,
  ...overrides,
});

describe('folder zip: names', () => {
  it('makes a name safe as one path segment', () => {
    expect(safeName('a/b\\c:d*e?"f<g>h|i', 'x')).to.equal('a_b_c_d_e__f_g_h_i');
    expect(safeName('..', 'x')).to.equal('_');
    expect(safeName('   ', 'Folder')).to.equal('Folder');
  });

  it('numbers a repeated name, whatever its case', () => {
    const unique = uniqueNamer();
    expect(unique('Budget.xlsx')).to.equal('Budget.xlsx');
    expect(unique('budget.xlsx')).to.equal('budget (1).xlsx');
    expect(unique('Budget.xlsx')).to.equal('Budget (2).xlsx');
    expect(unique('README')).to.equal('README');
    expect(unique('README')).to.equal('README (1)');
  });
});

describe('folder zip: what goes in', () => {
  it('keeps the folder tree, empty folders included', () => {
    const { directories, entries, skipped } = plan();
    expect(directories).to.deep.equal([
      'Day 27/', 'Day 27/Call sheets/', 'Day 27/Contracts/', 'Day 27/Empty/',
    ]);
    expect(entries.map((entry) => entry.name)).to.deep.equal([
      'Day 27/Call sheets/notes.md', 'Day 27/Contracts/deal.pdf', 'Day 27/Budget.xlsx',
    ]);
    expect(entries[0]).to.include({ s3Key: 'p1/drive/002_notes.md', bucket: 'bucket', region: 'ap-south-1' });
    expect(skipped).to.deep.equal([]);
  });

  it('leaves out a sub-folder this person only views', () => {
    const { entries, skipped } = plan({ roleByFolderId: new Map([[LOCKED, 'viewer']]) });
    expect(entries.map((entry) => entry.name)).to.not.include('Day 27/Contracts/deal.pdf');
    expect(skipped).to.deep.equal([{ path: 'Day 27/Contracts/deal.pdf', reason: 'no download permission' }]);
  });

  it('leaves out a file restricted for this person, and keeps one they uploaded', () => {
    const restricted = new Map([[files[0]._id, { can_view: true, can_download: false }]]);
    expect(plan({ fileAccessById: restricted }).skipped.map((item) => item.path))
      .to.deep.equal(['Day 27/Budget.xlsx']);

    const mine = [{ ...files[2], uploaded_by: USER }];
    const viewOnly = new Map([[LOCKED, 'viewer']]);
    expect(plan({ files: mine, roleByFolderId: viewOnly }).entries.map((entry) => entry.name))
      .to.deep.equal(['Day 27/Contracts/deal.pdf']);
  });

  it('an explicit file permission beats the folder role, both ways', () => {
    const allowed = new Map([[files[2]._id, { can_view: true, can_download: true }]]);
    const viewOnly = new Map([[LOCKED, 'viewer']]);
    expect(plan({ fileAccessById: allowed, roleByFolderId: viewOnly }).skipped).to.deep.equal([]);
  });

  it('lists a file with no stored content instead of failing', () => {
    const broken = [{ ...files[0], file_path: null, attachments: [] }];
    expect(plan({ files: broken }).skipped)
      .to.deep.equal([{ path: 'Day 27/Budget.xlsx', reason: 'no stored content' }]);
  });

  it('gives two items with one name different names in the zip', () => {
    const twins = [file('001', 'Budget.xlsx', ROOT), file('009', 'budget.xlsx', ROOT)];
    const names = plan({ files: twins }).entries.map((entry) => entry.name.toLowerCase());
    expect(names).to.have.members(['day 27/budget.xlsx', 'day 27/budget (1).xlsx']);
  });

  it('resolves roles like the rest of Drive: the closest folder wins', () => {
    const deep = '64b0000000000000000000d9';
    const roles = effectiveRoles({
      rootId: ROOT,
      rootRole: 'editor',
      folders: [...tree, folder(deep, 'Signed', LOCKED, { created_by: USER })],
      roleByFolderId: new Map([[LOCKED, 'viewer']]),
      userId: USER,
    });
    expect(roles.get(SUB)).to.equal('editor');
    expect(roles.get(LOCKED)).to.equal('viewer');
    expect(roles.get(deep)).to.equal('owner');
  });
});

describe('folder zip: the link and the download', () => {
  let role;
  let s3Send;

  const collect = () => {
    const res = new PassThrough();
    const headers = {};
    res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
    res.headersSent = false;
    const chunks = [];
    res.on('data', (chunk) => { res.headersSent = true; chunks.push(chunk); });
    const done = new Promise((resolve) => { res.on('end', () => resolve(Buffer.concat(chunks))); });
    return { res, headers, done };
  };

  const tokenFor = (extra = {}) => signAccessToken({
    type: 'folder_zip', folderId: ROOT, projectId: PROJECT, userId: USER, ...extra,
  }, 120);

  beforeEach(() => {
    role = 'editor';
    sinon.stub(DriveFolderRepository, 'getFolder').resolves(root);
    sinon.stub(DriveAccessService, 'resolveFolderRole').callsFake(async () => role);
    sinon.stub(DriveAccessService, 'collectDescendantFolderIds').resolves([ROOT, SUB, EMPTY, LOCKED]);
    sinon.stub(DriveFolderRepository, 'getFolders').resolves([root, ...tree]);
    sinon.stub(DriveFileRepository, 'getFiles').resolves(files);
    sinon.stub(DriveFolderAccessRepository, 'getAccesses').resolves([{ folder_id: LOCKED, role: 'viewer' }]);
    sinon.stub(DriveFileAccessRepository, 'getAccesses').resolves([]);
    s3Send = sinon.stub().callsFake(async (command) => ({
      Body: Readable.from([Buffer.from(`content of ${command.input.Key}`)]),
    }));
    sinon.stub(driveS3, 'getS3Client').returns({ send: s3Send });
  });

  afterEach(() => sinon.restore());

  it('gives owners and editors a short-lived link named after the folder', async () => {
    const link = await DriveFolderZip.createDownloadLink({
      user: { _id: USER }, project: { _id: PROJECT }, params: { folderId: ROOT },
    });
    expect(link.file_name).to.equal('Day 27.zip');
    expect(link.expires_in_seconds).to.equal(120);
    expect(link.token).to.be.a('string');
  });

  it('refuses a viewer, and someone with no access at all', async () => {
    for (const denied of ['viewer', null]) {
      role = denied;
      let error;
      try {
        await DriveFolderZip.createDownloadLink({
          user: { _id: USER }, project: { _id: PROJECT }, params: { folderId: ROOT },
        });
      } catch (caught) { error = caught; }
      expect(error && error.message).to.equal('insufficient_permissions');
    }
  });

  it('streams the tree as a zip and lists what was left out', async () => {
    const { res, headers, done } = collect();
    await DriveFolderZip.streamZip({ query: { token: tokenFor() }, res });
    const zip = readZip(await done);
    const names = Object.keys(zip);

    expect(headers['content-type']).to.equal('application/zip');
    expect(headers['content-disposition']).to.include('filename="Day 27.zip"');
    expect(names).to.include.members([
      'Day 27/Empty/', 'Day 27/Call sheets/notes.md', 'Day 27/Budget.xlsx', '_skipped.txt',
    ]);
    expect(names).to.not.include('Day 27/Contracts/deal.pdf');

    expect(zip['Day 27/Budget.xlsx'].text).to.equal('content of p1/drive/001_Budget.xlsx');
    expect(zip['Day 27/Call sheets/notes.md'].text).to.equal('content of p1/drive/002_notes.md');
    expect(zip['_skipped.txt'].text).to.include('Day 27/Contracts/deal.pdf  (no download permission)');
    // Already-compressed types are stored as they are; text is deflated.
    expect(zip['Day 27/Budget.xlsx'].stored).to.equal(true);
    expect(zip['Day 27/Call sheets/notes.md'].stored).to.equal(false);
    // One object at a time, and nothing fetched for the skipped file.
    expect(s3Send.callCount).to.equal(2);
  });

  it('checks the role again when the link is used', async () => {
    role = 'viewer';
    const { res } = collect();
    let error;
    try {
      await DriveFolderZip.streamZip({ query: { token: tokenFor() }, res });
    } catch (caught) { error = caught; }
    expect(error && error.message).to.equal('insufficient_permissions');
    expect(s3Send.called).to.equal(false);
  });

  it('refuses a missing, wrong-purpose or expired link', async () => {
    const editorToken = signAccessToken({ fileId: 'x', projectId: PROJECT, userId: USER }, 120);
    const expired = signAccessToken({
      type: 'folder_zip', folderId: ROOT, projectId: PROJECT, userId: USER,
    }, -10);
    const messages = [];
    for (const token of [undefined, editorToken, expired, 'garbage']) {
      try {
        await DriveFolderZip.streamZip({ query: { token }, res: collect().res });
      } catch (caught) { messages.push(caught.message); }
    }
    expect(messages).to.deep.equal([
      'missing_download_token',
      'invalid_or_expired_download_link',
      'invalid_or_expired_download_link',
      'invalid_or_expired_download_link',
    ]);
  });

  it('keeps going when one object cannot be read, and says so', async () => {
    s3Send.callsFake(async (command) => {
      if (command.input.Key.includes('Budget')) throw new Error('NoSuchKey');
      return { Body: Readable.from([Buffer.from('ok')]) };
    });
    const { res, done } = collect();
    await DriveFolderZip.streamZip({ query: { token: tokenFor() }, res });
    const zip = readZip(await done);
    expect(zip['_skipped.txt'].text).to.include('Day 27/Budget.xlsx  (could not be read)');
    expect(zip['Day 27/Call sheets/notes.md'].text).to.equal('ok');
  });
});

describe('folder zip and text routes', () => {
  const routes = (name) => require(`../src/routes/v2/${name}`).default.stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);

  it('matches the zip download before "/:folderId" would swallow it', () => {
    const folders = routes('driveFolder');
    expect(folders).to.include('POST /:folderId/download-zip');
    expect(folders.indexOf('GET /download-zip')).to.be.within(0, folders.indexOf('GET /:folderId') - 1);
  });

  it('serves a text file under the file routes', () => {
    expect(routes('driveFile')).to.include.members(['GET /:fileId/text', 'PUT /:fileId/text']);
  });
});
