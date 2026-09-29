/**
 * Make page-1 thumbnails for PDFs uploaded before PDF thumbnails existed.
 *
 *   node dist/jobs/backfillPdfThumbnails.js                 dry run: lists what it would do
 *   node dist/jobs/backfillPdfThumbnails.js --apply         makes the thumbnails
 *
 *   --project <id>   only this project
 *   --limit <n>      at most n files, newest first (default 200, max 5000)
 *
 * One file at a time, through the same code as new uploads. Deleted files,
 * files that already have a thumbnail and PDFs over the size limit are left
 * alone, so it is safe to run again. "Date modified" is not touched and no
 * socket events are sent.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { mongodbConnect } from 'zillit-libs/config';

import DriveFileRepository from '../repositories/v2/driveFile.js';
import DrivePdfThumbnail from '../services/v2/drivePdfThumbnail.js';

dotenv.config();

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const APPLY = process.argv.includes('--apply');
const LIMIT = Math.min(Number(option('limit')) || 200, 5000);
const PROJECT = option('project');

const pdfsWithoutThumbnail = () => ({
  deleted_on: 0,
  ...(PROJECT ? { project_id: new mongoose.Types.ObjectId(PROJECT) } : {}),
  $and: [
    { $or: [{ mime_type: 'application/pdf' }, { file_extension: 'pdf' }, { file_name: /\.pdf$/i }] },
    { $or: [{ 'attachments.0.thumbnail': { $in: [null, ''] } }, { 'attachments.0.thumbnail': { $exists: false } }] },
  ],
});

const run = async () => {
  await mongodbConnect(process.env.DB_URL);
  const files = await DriveFileRepository.getFiles({
    filters: pdfsWithoutThumbnail(),
    sort: { created_on: -1 },
    limit: LIMIT,
  });

  console.log(`[pdf_thumbnail_backfill] ${APPLY ? 'APPLY' : 'DRY RUN'} project=${PROJECT || 'all'} limit=${LIMIT} found=${files.length}`);
  const counts = { created: 0, skipped: 0 };

  // eslint-disable-next-line no-restricted-syntax
  for (const file of files) {
    if (!APPLY) {
      console.log(`  would make: ${file._id} ${file.file_size_bytes || 0}B ${file.file_name}`);
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const key = await DrivePdfThumbnail.generatePdfThumbnail({
      projectId: file.project_id, file, reason: 'backfill',
    });
    counts[key ? 'created' : 'skipped'] += 1;
  }

  if (APPLY) console.log(`[pdf_thumbnail_backfill] done created=${counts.created} skipped_or_failed=${counts.skipped}`);
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[pdf_thumbnail_backfill] failed:', error.message);
    process.exit(1);
  });
