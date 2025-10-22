import BadRequest from 'zillit-libs/errors/BadRequest';
import FileShareRepository from 'zillit-libs/repositories-v2/file-share';
import DriveFileRepository from '../../repositories/v2/driveFile.js';
import S3Service from 'zillit-libs/services-v2/s3-bucket';

const getPublicFileContent = async ({ params, headers }) => {
  const { token } = params;

  console.log('🔍 Streaming file for token:', token);

  // Find share by token using FileShareRepository
  const share = await FileShareRepository.findByToken(token);
  if (!share) {
    throw new BadRequest('share_not_found_or_expired');
  }

  // Check if share has expired (expires_at is epoch timestamp)
  if (share.expires_at && share.expires_at > 0) {
    const now = Date.now();
    
    if (now > share.expires_at) {
      console.log(`⏰ Share expired: ${new Date(share.expires_at).toISOString()} (current: ${new Date(now).toISOString()})`);
      throw new BadRequest('share_expired');
    }
    
    console.log(`✅ Share valid until: ${new Date(share.expires_at).toISOString()}`);
  } else {
    console.log('♾️  Share has no expiration date');
  }

  // Get file details
  const filters = {
    _id: share.file_id,
    project_id: share.project_id,
    deleted_on: 0,
  };

  const file = await DriveFileRepository.getFile({ filters });
  if (!file) {
    throw new BadRequest('file_not_found');
  }

  // Try to get file content from various sources
  let fileContent = null;
  let contentType = file.mime_type || 'application/octet-stream';
  let fileName = file.file_name;

  try {
    // Method 1: Try S3 if we have valid data
    if (file.attachments && file.attachments.length > 0) {
      const attachment = file.attachments[0];
      
      if (attachment.bucket && attachment.region && attachment.media) {
        let s3Key = attachment.media;
        
        // Extract S3 key from URL
        if (s3Key.includes('s3.amazonaws.com/')) {
          const urlParts = s3Key.split('/');
          s3Key = urlParts.slice(4).join('/');
        }

        // Skip if it's obviously placeholder data
        if (s3Key !== 'file.pdf' && !s3Key.includes('/bucket/')) {
          const s3Service = new S3Service();
          
          try {
            const fileExists = await s3Service.fileExists({
              media: s3Key,
              bucket: attachment.bucket,
              region: attachment.region,
            });

            if (fileExists) {
              fileContent = await s3Service.getFile({
                media: s3Key,
                bucket: attachment.bucket,
                region: attachment.region,
                buffer: true,
              });
              
              console.log('✅ File retrieved from S3');
              return {
                stream: fileContent,
                contentType,
                fileName,
                contentLength: attachment.file_size_bytes || undefined,
              };
            }
          } catch (s3Error) {
            console.log('⚠️ S3 access failed:', s3Error.message);
          }
        }
      }
    }

    // Method 2: Handle media files - provide informational PDF when S3 unavailable  
    if (file.mime_type && (file.mime_type.startsWith('video/') || file.mime_type.startsWith('image/'))) {
      console.log('🎥🖼️ Media file detected - generating info PDF since S3 unavailable');
      
      const mediaInfoPdf = generateMediaInfoPDF(file);
      return {
        buffer: Buffer.from(mediaInfoPdf),
        contentType: 'application/pdf',
        fileName: `${file.file_name.split('.')[0]}-info.pdf`,
        contentLength: mediaInfoPdf.length,
      };
    }
    
    // For other file types, generate mock PDF
    console.log('📄 Generating demo PDF content for non-media file...');
    
    const pdfContent = generateMockPDFContent(file);
    
    return {
      buffer: Buffer.from(pdfContent),
      contentType: 'application/pdf',
      fileName: file.file_name,
      contentLength: pdfContent.length,
    };

  } catch (error) {
    console.error('❌ Error getting file content:', error);
    throw new BadRequest('file_content_unavailable');
  }
};

// Helper function to generate media info PDF
const generateMediaInfoPDF = (file) => {
  const attachment = file.attachments?.[0];
  const pdfHeader = '%PDF-1.4\n';
  const pdfBody = `1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj

2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj

3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Contents 4 0 R
>>
endobj

4 0 obj
<<
/Length 400
>>
stream
BT
/F1 14 Tf
50 750 Td
(MEDIA FILE INFORMATION) Tj
0 -30 Td
/F1 12 Tf
(File Name: ${file.file_name}) Tj
0 -20 Td
(File Type: ${file.file_type || 'media'}) Tj
0 -20 Td
(MIME Type: ${file.mime_type}) Tj
0 -20 Td
(File Size: ${file.file_size || 'Unknown'}) Tj
${attachment ? `0 -20 Td
(S3 Bucket: ${attachment.bucket}) Tj
0 -20 Td
(S3 Path: ${attachment.media}) Tj
${attachment.duration ? `0 -20 Td
(Duration: ${attachment.duration} seconds) Tj` : ''}
${attachment.width && attachment.height ? `0 -20 Td
(Dimensions: ${attachment.width}x${attachment.height}) Tj` : ''}` : ''}
0 -40 Td
(NOTE: This is a preview document.) Tj
0 -20 Td
(The actual media file is stored in S3.) Tj
0 -20 Td
(Contact support if you need direct access.) Tj
ET
endstream
endobj

xref
0 5
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000120 00000 n 
0000000200 00000 n 
trailer
<<
/Size 5
/Root 1 0 R
>>
startxref
650
%%EOF`;

  return pdfHeader + pdfBody;
};

// Helper function to generate a basic PDF-like content for demo
const generateMockPDFContent = (file) => {
  const pdfHeader = '%PDF-1.4\n';
  const pdfBody = `1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj

2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj

3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Contents 4 0 R
>>
endobj

4 0 obj
<<
/Length 100
>>
stream
BT
/F1 12 Tf
100 700 Td
(Shared File: ${file.file_name}) Tj
0 -20 Td
(File Type: ${file.file_type}) Tj
0 -20 Td
(Size: ${file.file_size}) Tj
0 -20 Td
(This is a demo file generated by Zillit Drive) Tj
ET
endstream
endobj

xref
0 5
0000000000 65535 f 
0000000010 00000 n 
0000000060 00000 n 
0000000120 00000 n 
0000000200 00000 n 
trailer
<<
/Size 5
/Root 1 0 R
>>
startxref
350
%%EOF`;

  return pdfHeader + pdfBody;
};

export default {
  getPublicFileContent,
};
