# Zillit Drive API - CURL Commands Reference

## Environment Variables
Set these variables before running the commands:

```bash
export BASE_URL="http://localhost:8105"
export MODULE_DATA="9bf45a428070559f3376f051dd8877f1cdc26fed18a17e5d9f05337339f17aaa2dcb4c3474635573f852906b03eeab055b53675d1c163c04a58173d85a4fba3bc24b2494c14e2f943e44738ecfe9dab8818d7fe7a9ac6ecbd9bffa85e295cd4f8f288371124b3e34ff5989b589685eb975bc1eb34020fb1924b72e64c1fd4d73f9e439c1ab7104103a2f2094f8ff6e40349954d10bee1fde2f9df25fd019413b"
```

## Drive Folder APIs

### 1. Create Folder
```bash
curl --location "${BASE_URL}/api/v2/drive/folders" \
  -H "Content-Type: application/json" \
  -H "moduledata: ${MODULE_DATA}" \
  -d '{
    "folder_name": "My Documents",          // string, required - Name of the folder
    "parent_folder_id": null,               // string (ObjectId) or null, optional - Parent folder ID
    "description": "Main documents folder", // string, optional - Folder description
    "attachments": [                        // array, optional - Array of attachment objects
      {
        "media": "https://example.com/thumbnail.jpg",  // string, optional - Media URL
        "name": "folder_thumbnail",                     // string, optional - Attachment name
        "thumbnail": "https://example.com/thumb.jpg",  // string, optional - Thumbnail URL
        "content_type": "image",                        // string, optional - Content type (document/image/audio/video)
        "content_subtype": "jpeg",                      // string, optional - Content subtype
        "caption": "Folder thumbnail",                  // string, optional - Caption text
        "duration": 0,                                  // number, optional - Duration for media files
        "height": 150,                                  // number, optional - Height in pixels
        "width": 150,                                   // number, optional - Width in pixels
        "bucket": "zillit-bucket",                      // string, optional - S3 bucket name
        "region": "us-east-1",                          // string, optional - AWS region
        "created": 1697462400000,                       // number, optional - Creation timestamp
        "file_size": "2KB",                             // string, optional - Human readable file size
        "content_id": "content_123"                     // string, optional - Content identifier
      }
    ]
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "folder_created",
  "data": {
    "_id": "654321098765432109876543",
    "folder_name": "My Documents",
    "parent_folder_id": null,
    "description": "Main documents folder",
    "project_id": "507f1f77bcf86cd799439011",
    "user_id": "507f1f77bcf86cd799439022",
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-15T10:30:00.000Z",
    "attachments": [...]
  }
}
```

### 2. Get All Folders
```bash
curl --location "${BASE_URL}/api/v2/drive/folders?parent_folder_id=" \
  -H "moduledata: ${MODULE_DATA}"
```

**Expected Response:**
```json
{
  "success": true,
  "message": "folders_fetched",
  "data": {
    "folders": [
      {
        "_id": "654321098765432109876543",
        "folder_name": "My Documents",
        "parent_folder_id": null,
        "description": "Main documents folder",
        "created_at": "2024-01-15T10:30:00.000Z"
      }
    ],
    "pagination": {
      "current_page": 1,
      "total_pages": 1,
      "total_count": 1
    }
  }
}
```

### 3. Get Specific Folder
```bash
curl -X GET "${BASE_URL}/api/v2/drive-folders/654321098765432109876543" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}"
```

### 4. Get Folder Contents
```bash
curl -X GET "${BASE_URL}/api/v2/drive/folders/654321098765432109876543/contents" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}"
```

**Expected Response:**
```json
{
  "success": true,
  "message": "folder_contents_fetched",
  "data": {
    "folders": [
      {
        "_id": "654321098765432109876544",
        "folder_name": "Images",
        "parent_folder_id": "654321098765432109876543"
      }
    ],
    "files": [
      {
        "_id": "765432109876543210987654",
        "file_name": "document.pdf",
        "folder_id": "654321098765432109876543",
        "file_type": "pdf"
      }
    ]
  }
}
```

### 5. Update Folder
```bash
curl -X PUT "${BASE_URL}/api/v2/drive-folders/654321098765432109876543" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}" \
  -d '{
    "folder_id": "654321098765432109876543",           // string (ObjectId), optional - Folder ID for validation
    "folder_name": "Updated Documents",                // string, optional - New folder name
    "description": "Updated description for documents folder", // string, optional - Updated description
    "parent_folder_id": null,                          // string (ObjectId) or null, optional - New parent folder ID
    "attachments": [                                   // array, optional - Updated attachments array
      {
        "media": "https://example.com/new-thumb.jpg", // string, optional - Updated media URL
        "name": "updated_thumbnail",                   // string, optional - Updated attachment name
        "content_type": "image",                       // string, optional - Content type
        "content_subtype": "png",                      // string, optional - Content subtype
        "caption": "Updated thumbnail",                // string, optional - Updated caption
        "height": 200,                                 // number, optional - Updated height
        "width": 200,                                  // number, optional - Updated width
        "file_size": "3KB"                             // string, optional - Updated file size
      }
    ]
  }'
```

### 6. Delete Folder
```bash
curl -X DELETE "${BASE_URL}/api/v2/drive-folders/654321098765432109876543?force=false" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}"
```

## Drive File APIs

### 1. Create File
```bash
curl -X POST "${BASE_URL}/api/v2/drive-files/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}" \
  -d '{
    "file_name": "project_report.pdf",                 // string, required - Name of the file
    "folder_id": "654321098765432109876543",           // string (ObjectId) or null, optional - Parent folder ID
    "file_path": "/documents/reports/",                // string, optional - File path/location
    "description": "Monthly project report",          // string, optional - File description
    "file_type": "pdf",                               // string, optional - File type (pdf, doc, jpg, etc.)
    "file_extension": "pdf",                          // string, optional - File extension
    "file_size": "2.5MB",                             // string, optional - Human readable file size
    "file_size_bytes": 2621440,                       // number, optional - File size in bytes
    "mime_type": "application/pdf",                   // string, optional - MIME type
    "attachments": [                                  // array, optional - File attachments array (based on attachmentSchema)
      {
        "media": "https://s3.amazonaws.com/bucket/file.pdf",        // string, optional - File URL/media path
        "name": "project_report.pdf",                               // string, optional - Attachment name
        "thumbnail": "https://cdn.zillit.com/thumbs/report_thumb.jpg", // string, optional - Thumbnail URL
        "content_type": "document",                                  // string, optional - Content type (document, image, audio, video)
        "content_subtype": "pdf",                                   // string, optional - Exact extension of attachment
        "caption": "Monthly project report",                        // string, optional - Attachment caption
        "duration": 0,                                              // number, optional - Duration for media files
        "height": 0,                                                // number, optional - Height for images/videos
        "width": 0,                                                 // number, optional - Width for images/videos
        "bucket": "zillit-drive-files",                             // string, optional - S3 bucket name
        "region": "us-east-1",                                      // string, optional - S3 region
        "created": 1705334400000,                                   // number, optional - Creation timestamp
        "file_size": "2.5MB",                                       // string, optional - Human readable file size
        "content_id": "drive_file_123"                              // string, optional - Content identifier
      }
    ]
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "file_created",
  "data": {
    "_id": "765432109876543210987654",
    "file_name": "project_report.pdf",
    "folder_id": "654321098765432109876543",
    "file_path": "/documents/reports/",
    "description": "Monthly project report",
    "file_type": "pdf",
    "file_size": "2.5MB",
    "file_size_bytes": 2621440,
    "mime_type": "application/pdf",
    "created_at": "2024-01-15T12:00:00.000Z",
    "attachment": {...}
  }
}
```

### 2. Get All Files
```bash
curl -X GET "${BASE_URL}/api/v2/drive/files/?folder_id=654321098765432109876543&file_type=pdf" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}"
```

### 3. Get Files By Type
```bash
curl -X GET "${BASE_URL}/api/v2/drive/files/by-type?file_type=pdf" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}"
```

**Expected Response:**
```json
{
  "success": true,
  "message": "files_by_type_fetched",
  "data": {
    "files": [
      {
        "_id": "765432109876543210987654",
        "file_name": "project_report.pdf",
        "folder_id": "654321098765432109876543",
        "file_type": "pdf",
        "file_size": "2.5MB",
        "mime_type": "application/pdf"
      }
    ]
  }
}
```

### 4. Get Specific File
```bash
curl -X GET "${BASE_URL}/api/v2/drive-files/765432109876543210987654" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}"
```

### 5. Update File
```bash
curl -X PUT "${BASE_URL}/api/v2/drive-files/765432109876543210987654" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}" \
  -d '{
    "file_id": "765432109876543210987654",            // string (ObjectId), optional - File ID for validation
    "file_name": "updated_project_report.pdf",       // string, optional - Updated file name
    "folder_id": "654321098765432109876543",          // string (ObjectId) or null, optional - New folder ID
    "file_path": "/documents/updated/",               // string, optional - Updated file path
    "description": "Updated monthly project report with latest data", // string, optional - Updated description
    "file_type": "pdf",                               // string, optional - Updated file type
    "file_size": "3.2MB",                             // string, optional - Updated file size
    "file_size_bytes": 3355443,                       // number, optional - Updated file size in bytes
    "mime_type": "application/pdf",                   // string, optional - Updated MIME type
    "attachment": {                                   // object, optional - Updated attachment details
      "url": "https://s3.amazonaws.com/bucket/updated_file.pdf",  // string, optional - Updated file URL
      "bucket": "zillit-drive-files",                             // string, optional - Updated bucket name
      "key": "files/updated_report_456.pdf",                     // string, optional - Updated S3 key
      "cdn_url": "https://cdn.zillit.com/files/updated_report_456.pdf", // string, optional - Updated CDN URL
      "original_name": "updated_project_report.pdf",             // string, optional - Updated original name
      "size": 3355443,                                           // number, optional - Updated size in bytes
      "mime_type": "application/pdf",                             // string, optional - Updated MIME type
      "encoding": "utf-8"                                         // string, optional - Updated encoding
    }
  }'
```

### 6. Move File
```bash
curl -X PUT "${BASE_URL}/api/v2/drive-files/765432109876543210987654/move" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}" \
  -d '{
    "target_folder_id": "654321098765432109876544"    // string (ObjectId) or null, optional - Target folder ID to move file to
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "message": "file_moved",
  "data": {
    "_id": "765432109876543210987654",
    "file_name": "updated_project_report.pdf",
    "folder_id": "654321098765432109876544",
    "previous_folder_id": "654321098765432109876543",
    "moved_at": "2024-01-15T17:00:00.000Z"
  }
}
```

### 7. Delete File
```bash
curl -X DELETE "${BASE_URL}/api/v2/drive-files/765432109876543210987654" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "device-id: ${DEVICE_ID}" \
  -H "project-id: ${PROJECT_ID}" \
  -H "user-id: ${USER_ID}"
```

**Expected Response:**
```json
{
  "success": true,
  "message": "file_deleted",
  "data": {
    "deleted_file_id": "765432109876543210987654",
    "deleted_at": "2024-01-15T18:00:00.000Z"
  }
}
```

## Required Headers

All APIs require these headers:
- `Authorization: Bearer {access_token}` - JWT/Bearer token for authentication
- `device-id: {device_id}` - Unique device identifier 
- `project-id: {project_id}` - MongoDB ObjectId for project
- `user-id: {user_id}` - MongoDB ObjectId for user
- `Content-Type: application/json` - For POST/PUT requests

## Common Query Parameters

### Pagination (GET requests):


### Filtering:
- **Folders**: `parent_folder_id` - Filter by parent folder
- **Files**: `folder_id`, `file_type` - Filter by folder or file type

## Error Responses

All APIs return consistent error responses:
```json
{
  "success": false,
  "message": "error_code",
  "error": {
    "code": "VALIDATION_ERROR",
    "details": "Specific error details"
  }
}
```

Common HTTP status codes:
- `200` - Success
- `201` - Created
- `400` - Bad Request (validation errors)
- `401` - Unauthorized
- `404` - Not Found
- `500` - Internal Server Error